import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Editor } from './editor/Editor.tsx'
import type { HistoryItem } from './editor/controller.ts'
import { api, type FileEntry, type Settings as SettingsT, type Status, type Thinking, type VoiceSummary } from './lib/api.ts'
import { applyPatch, joinFrontMatter, splitFrontMatter, type Meta, type MetaPatch } from './lib/frontmatter.ts'
import { Panel, type PanelTab } from './components/Panel.tsx'
import { Settings } from './components/Settings.tsx'
import { ThinkingSpace } from './components/ThinkingSpace.tsx'
import { VoicePage } from './components/VoicePage.tsx'
import { Sidebar, type SidebarMode } from './components/Sidebar.tsx'
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
  const [sidebarMode, setSidebarMode] = usePref<SidebarMode>('sidebarMode', 'vault')
  const [panelOpen, setPanelOpen] = usePref('panel', true)
  const [panelTab, setPanelTab] = usePref<PanelTab>('panelTab', 'piece')
  const [focus, setFocus] = useState(false)
  const [settings, setSettings] = useState<SettingsT | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [voices, setVoices] = useState<VoiceSummary[]>([])
  const [voiceView, setVoiceView] = useState<string | null>(null) // a platform whose profile fills the page
  const refreshVoices = useCallback(() => api.voice().then(setVoices), [])
  // The open document's Thinking Space, and which of its fragments the draft already uses.
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [thinking, setThinking] = useState<Thinking | null>(null)
  const [material, setMaterial] = useState<{ covered: string[]; nearest: string | null }>({ covered: [], nearest: null })
  const paragraph = useRef('')
  const materialTimer = useRef<number | undefined>(undefined)
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
    refreshVoices()
  }, [refreshFiles, refreshVoices])

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
    setThinking(null)
    setMaterial({ covered: [], nearest: null })
    api.thinking(path).then((t) => !cancelled && setThinking(t))
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
      setVoiceView(null)
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

  const setMeta = (patch: MetaPatch) => {
    const d = docRef.current
    if (!d) return
    d.meta = applyPatch(d.meta, patch)
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

  /** ★ a document as an exemplar of its platform, or un-star it. */
  const toggleExemplar = async (rel: string) => {
    const f = files.find((x) => x.path === rel)
    if (!f) return
    const patch = { exemplar: f.exemplar ? null : 'true' }
    setFiles((fs) => fs.map((x) => (x.path === rel ? { ...x, exemplar: !x.exemplar } : x)))
    // The open document saves through the editor, so its front-matter must change there too.
    if (docRef.current?.path === rel) setMeta(patch)
    else await api.patchMeta(rel, patch).then(refreshFiles)
    refreshVoices() // the profile for this platform is now out of date
  }

  const openVoice = (platform: string) => {
    refreshVoices()
    setVoiceView(platform)
  }

  const showSidebar = (mode: SidebarMode) => {
    if (mode === 'voice') refreshVoices()
    if (sidebarOpen && sidebarMode === mode) setSidebarOpen(false)
    else {
      setSidebarMode(mode)
      setSidebarOpen(true)
    }
  }

  /** Ask which fragments the draft covers, and which is nearest the paragraph being written. */
  const checkMaterial = useCallback(
    (delay = 700) => {
      window.clearTimeout(materialTimer.current)
      const d = docRef.current
      const frags = (thinking?.canvas.nodes ?? []).filter((n) => n.type === 'text' && n.text?.trim()).map((n) => ({ id: n.id, text: n.text! }))
      if (!d || !frags.length) return
      materialTimer.current = window.setTimeout(async () => {
        if (saveTimer.current !== undefined) await save() // coverage reads the saved draft
        api.thinkingMaterial(d.path, frags, paragraph.current).then(setMaterial).catch(() => {})
      }, delay)
    },
    [thinking, save],
  )
  useEffect(() => {
    if (panelOpen && panelTab === 'material') checkMaterial(0)
  }, [panelOpen, panelTab, checkMaterial])

  const onParagraph = useCallback(
    (text: string) => {
      if (text === paragraph.current) return
      paragraph.current = text
      if (panelOpen && panelTab === 'material') checkMaterial(1200)
    },
    [panelOpen, panelTab, checkMaterial],
  )

  const closeThinking = useCallback(() => {
    setThinkingOpen(false)
    const d = docRef.current
    if (!d) return
    // Back to drafting, with the fragments beside the page.
    api.thinking(d.path).then((t) => {
      setThinking(t)
      if (t.canvas.nodes.length) {
        setPanelOpen(true)
        setPanelTab('material')
      }
    })
  }, [setPanelOpen, setPanelTab])

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
      } else if (e.code === 'Digit8' && e.shiftKey && (e.metaKey || e.ctrlKey) !== e.altKey) {
        e.preventDefault()
        if (docRef.current) toggleExemplar(docRef.current.path)
      } else if (e.code === 'Comma' && !e.shiftKey && (e.metaKey || e.ctrlKey) !== e.altKey) {
        e.preventDefault()
        setSettingsOpen((o) => !o)
      } else if (e.code === 'KeyT' && !e.shiftKey && (e.metaKey || e.ctrlKey) !== e.altKey) {
        // ⌥T, since browsers keep ⌘T for a new tab. The Thinking Space closes itself.
        e.preventDefault()
        if (docRef.current && !thinkingOpen) {
          if (saveTimer.current !== undefined) save()
          setThinkingOpen(true)
        }
      } else if (e.code === 'KeyN' && !e.shiftKey && (e.metaKey || e.ctrlKey) !== e.altKey) {
        // Browsers keep ⌘N for a new window, so ⌥N works too.
        e.preventDefault()
        newDraft()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, save, newDraft, setPanelOpen, setPanelTab, files, thinkingOpen])

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
        <button className={`rail-btn${sidebarOpen && sidebarMode === 'vault' ? ' is-on' : ''}`} title="Vault" onClick={() => showSidebar('vault')}>
          <Icon name="folder" />
        </button>
        <button className={`rail-btn${sidebarOpen && sidebarMode === 'exemplars' ? ' is-on' : ''}`} title="Exemplars" onClick={() => showSidebar('exemplars')}>
          <Icon name="star" />
        </button>
        <button className={`rail-btn${sidebarOpen && sidebarMode === 'voice' ? ' is-on' : ''}`} title="Voice" onClick={() => showSidebar('voice')}>
          <Icon name="voice" />
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

      {sidebarOpen && <Sidebar mode={sidebarMode} files={files} voices={voices} voiceView={voiceView} onVoice={openVoice} current={voiceView ? null : path} onOpen={openDoc} onCreate={newDraft} onStar={toggleExemplar} />}

      <main className="page-area">
        {voiceView && (
          <VoicePage platform={voiceView} summary={voices.find((v) => v.platform === voiceView)} onOpenDoc={openDoc} onChanged={refreshVoices} />
        )}
        {loaded && !voiceView && (
          <div className="page">
            <div className="doc-meta">
              <label className="platform">
                <select value={platform} onChange={(e) => setMeta({ platform: e.target.value })} aria-label="Platform">
                  {(PLATFORMS.includes(platform) ? PLATFORMS : [...PLATFORMS, platform]).map((p) => (
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
              onParagraph={onParagraph}
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
          exemplar={!!current?.exemplar}
          voice={voices.find((v) => v.platform === platform)}
          onVoice={() => openVoice(platform)}
          thinking={thinking}
          covered={material.covered}
          nearest={material.nearest}
          onThinking={() => setThinkingOpen(true)}
          onExemplar={() => current && toggleExemplar(current.path)}
          onClearHistory={() => setHistory([])}
        />
      )}

      {thinkingOpen && loaded && <ThinkingSpace doc={loaded.path} title={title} onClose={closeThinking} />}

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
