import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Editor } from './editor/Editor.tsx'
import type { HistoryItem } from './editor/controller.ts'
import { api, type FileEntry, type Status } from './lib/api.ts'
import { joinFrontMatter, splitFrontMatter, type Meta } from './lib/frontmatter.ts'
import { Panel, type PanelTab } from './components/Panel.tsx'
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

export function App() {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [path, setPath] = usePref<string | null>('lastDoc', null)
  const [loaded, setLoaded] = useState<{ path: string; meta: Meta; body: string; rawMeta: string } | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [words, setWords] = useState(0)
  const [saved, setSaved] = useState<'saved' | 'saving' | 'unsaved'>('saved')

  const [sidebarOpen, setSidebarOpen] = usePref('sidebar', true)
  const [panelOpen, setPanelOpen] = usePref('panel', true)
  const [panelTab, setPanelTab] = usePref<PanelTab>('panelTab', 'piece')
  const [focus, setFocus] = useState(false)
  const [ceiling, setCeiling] = usePref('ceiling', 5)
  const [recallDot, setRecallDot] = usePref('recallDot', true)

  // Re-render labels once we learn ⌘+number reaches the page.
  const [mod, setMod] = useState(helpMod)
  useEffect(() => {
    const on = () => setMod(helpMod)
    window.addEventListener('ekdanta:helpmod', on)
    return () => window.removeEventListener('ekdanta:helpmod', on)
  }, [])

  const bodyRef = useRef('')
  const metaRef = useRef<{ meta: Meta; rawMeta: string }>({ meta: {}, rawMeta: '' })
  const saveTimer = useRef<number | undefined>(undefined)

  const refreshFiles = useCallback(() => api.files().then(setFiles), [])
  useEffect(() => {
    refreshFiles()
    api.status().then(setStatus)
  }, [refreshFiles])

  // Open the remembered document, or the first one in the vault.
  useEffect(() => {
    if (!files.length) return
    if (!path || !files.some((f) => f.path === path)) setPath(files[0].path)
  }, [files, path, setPath])

  useEffect(() => {
    if (!path) return
    let cancelled = false
    api.read(path).then((content) => {
      if (cancelled) return
      const { meta, body, raw } = splitFrontMatter(content)
      bodyRef.current = body
      metaRef.current = { meta, rawMeta: raw }
      setLoaded({ path, meta, body, rawMeta: raw })
      setSaved('saved')
    })
    api.history(path).then((h) => !cancelled && setHistory(h as HistoryItem[]))
    return () => {
      cancelled = true
    }
  }, [path])

  const save = useCallback(async () => {
    if (!loaded) return
    window.clearTimeout(saveTimer.current)
    setSaved('saving')
    await api.write(loaded.path, joinFrontMatter(metaRef.current.rawMeta, metaRef.current.meta, bodyRef.current))
    setSaved('saved')
  }, [loaded])

  const onChange = useCallback(
    (text: string) => {
      bodyRef.current = text
      setSaved('unsaved')
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(save, 800)
    },
    [save],
  )

  const setMeta = (patch: Meta) => {
    metaRef.current = { ...metaRef.current, meta: { ...metaRef.current.meta, ...patch } }
    setLoaded((l) => (l ? { ...l, meta: metaRef.current.meta } : l))
    save().then(refreshFiles)
  }

  const record = useCallback(
    (item: HistoryItem) => {
      if (!path) return
      setHistory((h) => [...h, item])
      api.appendHistory(path, item)
    },
    [path],
  )

  const createDoc = async (folder: string, name: string) => {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled'
    const rel = `${folder ? folder + '/' : ''}${slug}.md`
    const platform = PLATFORMS.find((p) => folder.toLowerCase().startsWith(p)) ?? 'essay'
    await api.write(rel, `---\ntitle: ${name.trim()}\nplatform: ${platform}\nstatus: draft\n---\n\n`)
    await refreshFiles()
    setPath(rel)
  }

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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus, save, setPanelOpen, setPanelTab])

  const current = files.find((f) => f.path === path)
  const platform = (loaded?.meta.platform ?? current?.platform ?? 'essay').toLowerCase()
  const title = loaded?.meta.title ?? current?.title ?? ''

  const editorProps = useMemo(
    () => ({
      doc: () => path ?? '',
      platform: () => (metaRef.current.meta.platform ?? 'essay').toLowerCase(),
      ceiling: () => ceiling,
      recallDot: () => recallDot && !focus,
    }),
    [path, ceiling, recallDot, focus],
  )

  return (
    <div className={`app${focus ? ' is-focus' : ''}${panelOpen ? ' has-panel' : ''}${sidebarOpen ? ' has-sidebar' : ''}`}>
      <header className="titlebar">
        <div className="crumb">
          {current?.folder ? <span className="muted">{current.folder} / </span> : null}
          <b>{title}</b>
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
        <div className="rail-spacer" />
        <button className="rail-btn" title="Focus mode (⌘.)" onClick={() => setFocus(true)}>
          <Icon name="focus" />
        </button>
      </nav>

      {sidebarOpen && <Sidebar files={files} current={path} onOpen={setPath} onCreate={createDoc} />}

      <main className="page-area">
        {loaded && (
          <div className="page">
            <div className="doc-meta">
              <label className="platform">
                <select value={platform} onChange={(e) => setMeta({ platform: e.target.value })} aria-label="Platform">
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p === 'linkedin' ? 'LinkedIn' : p[0].toUpperCase() + p.slice(1)}
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
            {title && <h1 className="doc-title">{title}</h1>}
            <Editor
              key={loaded.path}
              docKey={loaded.path}
              initial={loaded.body}
              onChange={onChange}
              {...editorProps}
              record={record}
              openDoc={setPath}
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
          onCeiling={setCeiling}
          recallDot={recallDot}
          onRecallDot={setRecallDot}
          status={status}
          path={path}
          onClearHistory={() => setHistory([])}
        />
      )}

      <footer className="statusbar">
        <span>
          {platform[0].toUpperCase() + platform.slice(1)} · Ceiling {ceiling} · {words.toLocaleString()} words
        </span>
        <span className="muted">
          {mod}1 Recall · {mod}2 Nudge · {mod}3 Word · {mod}4 Sentence · {mod}5 Passage
        </span>
      </footer>
    </div>
  )
}
