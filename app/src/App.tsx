import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Editor } from './editor/Editor.tsx'
import type { HistoryItem } from './editor/controller.ts'
import { api, type FileEntry, type Settings as SettingsT, type Status } from './lib/api.ts'
import { joinFrontMatter, splitFrontMatter, type Meta } from './lib/frontmatter.ts'
import { Panel, type PanelTab } from './components/Panel.tsx'
import { Settings } from './components/Settings.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Icon } from './components/Icon.tsx'
import { helpMod } from './editor/help.ts'

const PLATFORMS = ['essay', 'linkedin', 'email', 'text', 'blog']

function usePref<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem('ekdanta.' + key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('ekdanta.' + key, JSON.stringify(value))
    } catch {
      /* preferences are a convenience */
    }
  }, [key, value])
  return [value, setValue] as const
}

interface Doc {
  path: string
  meta: Meta
  body: string
  rawMeta: string
}

export function App() {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [path, setPath] = usePref<string | null>('lastDoc', null)
  // What's on screen. `key` changes only when a different document opens, not when one is renamed.
  const [loaded, setLoaded] = useState<(Doc & { key: string }) | null>(null)
  const [fresh, setFresh] = useState<string | null>(null) // a new draft, whose title gets the caret
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [words, setWords] = useState(0)
  const [saved, setSaved] = useState<'saved' | 'saving' | 'unsaved'>('saved')

  const [sidebarOpen, setSidebarOpen] = usePref('sidebar', true)
  const [panelOpen, setPanelOpen] = usePref('panel', true)
  const [panelTab, setPanelTab] = usePref<PanelTab>('panelTab', 'piece')
  const [focus, setFocus] = useState(false)
  const [settings, setSettings] = useState<SettingsT | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const ceiling = settings?.ceiling ?? 5
  const recallDot = settings?.recallDot ?? true
  const changeSettings = useCallback((patch: Partial<SettingsT>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    api.saveSettings(patch).then((next) => {
      setSettings(next)
      // Provider or model changes show up in the Piece module's Models list.
      if ('provider' in patch || 'wordLocal' in patch || 'embedder' in patch || /Model$/.test(Object.keys(patch)[0])) api.status().then(setStatus)
    })
  }, [])

  // Re-render labels once we learn ⌘+number reaches the page.
  const [mod, setMod] = useState(helpMod)
  useEffect(() => {
    const on = () => setMod(helpMod)
    window.addEventListener('ekdanta:helpmod', on)
    return () => window.removeEventListener('ekdanta:helpmod', on)
  }, [])

  // The open document. Saves always read from here, so a save can never land in the wrong file.
  const docRef = useRef<Doc | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const renamed = useRef<string | null>(null)

  const refreshFiles = useCallback(() => api.files().then(setFiles), [])
  useEffect(() => {
    refreshFiles()
    api.status().then(setStatus)
    api.settings().then(setSettings)
  }, [refreshFiles])

  // Appearance: follow the system unless the writer picked light or dark.
  useEffect(() => {
    const theme = settings?.theme ?? 'system'
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [settings?.theme])

  // Open the remembered document, or the first one in the vault.
  useEffect(() => {
    if (!files.length) return
    if (!path || !files.some((f) => f.path === path)) setPath(files[0].path)
  }, [files, path, setPath])

  useEffect(() => {
    if (!path) return
    if (renamed.current === path) {
      renamed.current = null // same document under a new name: nothing to reload
      return
    }
    let cancelled = false
    api.read(path).then((content) => {
      if (cancelled) return
      const { meta, body, raw } = splitFrontMatter(content)
      docRef.current = { path, meta, body, rawMeta: raw }
      setLoaded({ ...docRef.current, key: path })
      setSaved('saved')
    })
    api.history(path).then((h) => !cancelled && setHistory(h as HistoryItem[]))
    return () => {
      cancelled = true
    }
  }, [path])

  const save = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    const d = docRef.current
    if (!d) return
    setSaved('saving')
    await api.write(d.path, joinFrontMatter(d.rawMeta, d.meta, d.body))
    setSaved('saved')
  }, [])

  const onChange = useCallback(
    (text: string) => {
      if (docRef.current) docRef.current.body = text
      setSaved('unsaved')
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(save, 800)
    },
    [save],
  )

  /** Switch documents: finish any pending save first, and drop a new draft that was left empty. */
  const openDoc = useCallback(
    async (next: string) => {
      const d = docRef.current
      if (d && d.path !== next) {
        if (saveTimer.current !== undefined) await save()
        if (!d.meta.title?.trim() && !d.body.trim()) {
          const { discarded } = await api.discard(d.path)
          if (discarded) await refreshFiles()
        }
      }
      setFresh((f) => (f === next ? f : null))
      setPath(next)
    },
    [save, refreshFiles, setPath],
  )

  const newDraft = useCallback(
    async (folder?: string) => {
      const target = folder ?? files.find((f) => f.path === docRef.current?.path)?.folder ?? ''
      const { path: rel } = await api.create(target)
      await refreshFiles()
      setFresh(rel)
      await openDoc(rel)
    },
    [files, openDoc, refreshFiles],
  )

  const setMeta = (patch: Meta) => {
    const d = docRef.current
    if (!d) return
    d.meta = { ...d.meta, ...patch }
    setLoaded((l) => (l ? { ...l, meta: d.meta } : l))
    save().then(refreshFiles)
  }

  /** A title written for the first time also names the file. */
  const setTitle = async (title: string) => {
    const d = docRef.current
    if (!d) return
    d.meta = { ...d.meta, title }
    setLoaded((l) => (l ? { ...l, meta: d.meta } : l))
    await save()
    const { path: next } = await api.name(d.path, title)
    if (next !== d.path) {
      const prev = d.path
      d.path = next
      renamed.current = next
      setLoaded((l) => (l ? { ...l, path: next } : l))
      setFresh((f) => (f === prev ? next : f))
      setPath(next)
    }
    refreshFiles()
  }

  const record = useCallback(
    (item: HistoryItem) => {
      const d = docRef.current
      if (!d) return
      setHistory((h) => [...h, item])
      api.appendHistory(d.path, item)
    },
    [],
  )

  // Window-level shortcuts: Focus mode and the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === '.') {
        e.preventDefault()
        setFocus((f) => !f)
      } else if (focus && e.key === 'Escape' && !document.querySelector('.hl-card, .hl-line, .hl-nudge, .hl-bar, .cm-ins, .hl-ghost')) {
        setFocus(false)
      } else if (mod && e.key === '\\') {
        e.preventDefault()
        setPanelOpen((o) => !o)
      } else if (mod && e.altKey && /^Digit[123]$/.test(e.code)) {
        e.preventDefault()
        setPanelOpen(true)
        setPanelTab((['material', 'history', 'piece'] as const)[Number(e.code.slice(-1)) - 1])
      } else if (mod && e.key === 's') {
        e.preventDefault()
        save()
      } else if (e.code === 'Comma' && !e.shiftKey && (e.metaKey || e.ctrlKey) !== e.altKey) {
        e.preventDefault()
        setSettingsOpen((o) => !o)
      } else if (e.code === 'KeyN' && !e.shiftKey && (e.metaKey || e.ctrlKey) !== e.altKey) {
        // Browsers keep ⌘N for a new window, so ⌥N works too.
        e.preventDefault()
        newDraft()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus, save, newDraft, setPanelOpen, setPanelTab])

  const current = files.find((f) => f.path === path)
  const platform = (loaded?.meta.platform ?? current?.platform ?? 'essay').toLowerCase()
  const title = loaded ? (loaded.meta.title ?? current?.title ?? '') : ''
  const isNew = !!loaded && fresh === loaded.path

  const editorProps = useMemo(
    () => ({
      doc: () => docRef.current?.path ?? '',
      platform: () => (docRef.current?.meta.platform ?? 'essay').toLowerCase(),
      ceiling: () => ceiling,
      recallDot: () => recallDot && !focus,
    }),
    [path, ceiling, recallDot, focus],
  )

  return (
    <div
      className={`app${focus ? ' is-focus' : ''}${panelOpen ? ' has-panel' : ''}${sidebarOpen ? ' has-sidebar' : ''}${
        settings?.paragraphFocus === false ? ' no-para-focus' : ''
      }`}
    >
      <header className="titlebar">
        <div className="crumb">
          {current?.folder ? <span className="muted">{current.folder} / </span> : null}
          <b>{title || 'Untitled'}</b>
        </div>
        <div className="titlebar-meta">
          <span className={`save-state is-${saved}`}>{saved === 'saved' ? 'Saved' : saved === 'saving' ? 'Saving…' : 'Edited'}</span>
          <button className="icon-btn" title="Focus mode (⌘.)" onClick={() => setFocus(true)}>
            <Icon name="focus" />
          </button>
          <button className="icon-btn" title="Right panel (⌘\)" onClick={() => setPanelOpen((o) => !o)}>
            <Icon name="panel" />
          </button>
        </div>
      </header>

      <nav className="rail" aria-label="Main">
        <button className={`rail-btn${sidebarOpen ? ' is-on' : ''}`} title="Vault" onClick={() => setSidebarOpen((o) => !o)}>
          <Icon name="folder" />
        </button>
        <button className="rail-btn" title="New draft (⌥N)" onClick={() => newDraft()}>
          <Icon name="compose" />
        </button>
        <div className="rail-spacer" />
        <button className="rail-btn" title="Focus mode (⌘.)" onClick={() => setFocus(true)}>
          <Icon name="focus" />
        </button>
        <button className={`rail-btn${settingsOpen ? ' is-on' : ''}`} title="Settings (⌥,)" onClick={() => setSettingsOpen((o) => !o)}>
          <Icon name="settings" />
        </button>
      </nav>

      {sidebarOpen && <Sidebar files={files} current={path} onOpen={openDoc} onCreate={newDraft} />}

      <main className="page-area">
        {loaded && (
          <div className="page">
            <div className="doc-meta">
              <label className="platform">
                <select value={platform} onChange={(e) => setMeta({ platform: e.target.value })} aria-label="Platform">
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {platformLabel(p)}
                    </option>
                  ))}
                </select>
                <svg className="chevron" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3.5 4.75 6 7.25l2.5-2.5" />
                </svg>
              </label>
              <span className="muted">· {loaded.meta.status ?? 'draft'}</span>
              <span className="muted path">{loaded.path}</span>
            </div>
            <TitleField key={'title:' + loaded.key} value={loaded.meta.title ?? (current?.title === 'Untitled' ? '' : title)} autoFocus={isNew} onCommit={setTitle} />
            {isNew && !words && <PlatformPicker value={platform} onPick={(p) => setMeta({ platform: p })} />}
            <Editor
              key={loaded.key}
              docKey={loaded.key}
              autoFocus={!isNew}
              initial={loaded.body}
              onChange={onChange}
              {...editorProps}
              record={record}
              openDoc={openDoc}
              onWordCount={setWords}
            />
          </div>
        )}
        {focus && <div className="focus-hint">esc or ⌘. to exit focus</div>}
      </main>

      {panelOpen && (
        <Panel
          tab={(panelTab as string) === 'help' ? 'history' : panelTab}
          onTab={setPanelTab}
          onClose={() => setPanelOpen(false)}
          history={history}
          words={words}
          platform={platform}
          ceiling={ceiling}
          onCeiling={(ceiling) => changeSettings({ ceiling })}
          recallDot={recallDot}
          onRecallDot={(recallDot) => changeSettings({ recallDot })}
          status={status}
          path={loaded?.path ?? path}
          onClearHistory={() => setHistory([])}
        />
      )}

      {settingsOpen && settings && <Settings settings={settings} status={status} onChange={changeSettings} onClose={() => setSettingsOpen(false)} />}

      <footer className="statusbar">
        <span>
          {platformLabel(platform)} · Ceiling {ceiling} · {words.toLocaleString()} words
        </span>
        <span className="muted">
          {mod}1 Recall · {mod}2 Nudge · {mod}3 Word · {mod}4 Sentence · {mod}5 Passage
        </span>
      </footer>
    </div>
  )
}

const platformLabel = (p: string) => (p === 'linkedin' ? 'LinkedIn' : p[0].toUpperCase() + p.slice(1))

/** The document title, edited in place. Return or ↓ moves on to the text. */
function TitleField({ value, autoFocus, onCommit }: { value: string; autoFocus: boolean; onCommit: (t: string) => void }) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el && el.textContent !== value) el.textContent = value
  }, [value])
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  const commit = () => {
    const t = (ref.current?.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (ref.current) ref.current.textContent = t
    if (t !== value) onCommit(t)
  }
  return (
    <h1
      ref={ref}
      className="doc-title"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-label="Title"
      data-placeholder="Untitled"
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
          e.preventDefault()
          focusText()
        } else if (e.key === 'Escape') {
          e.currentTarget.textContent = value
          focusText()
        }
      }}
    />
  )
}

function focusText() {
  document.querySelector<HTMLElement>('.cm-content')?.focus()
}

/** On a new document: which platform it's for. The folder's usual one is already chosen. */
function PlatformPicker({ value, onPick }: { value: string; onPick: (p: string) => void }) {
  return (
    <div className="platform-picker" role="radiogroup" aria-label="Platform">
      <span className="muted">For</span>
      {PLATFORMS.map((p) => (
        <button key={p} role="radio" aria-checked={p === value} tabIndex={-1} className={p === value ? 'is-on' : ''} onClick={() => onPick(p)}>
          {platformLabel(p)}
        </button>
      ))}
    </div>
  )
}
