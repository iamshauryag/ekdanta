import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Editor as TiptapEditor } from '@tiptap/core'
import { Editor, helpLevel, type EditorFormat, type Heading } from './editor/Editor.tsx'
import type { PageRef } from './editor/menus.ts'
import { SourceEditor } from './editor/Source.tsx'
import { findKind, kindName, kinds, setKinds } from './lib/kinds.ts'
import { Toolbar } from './components/Toolbar.tsx'
import type { HistoryItem } from './editor/controller.ts'
import { api, type FileEntry, type Settings as SettingsT, type Status, type Thinking, type Trashed, type VoiceSummary } from './lib/api.ts'
import { applyPatch, joinFrontMatter, splitFrontMatter, type Meta, type MetaPatch } from './lib/frontmatter.ts'
import { Panel, type HistorySeg, type PanelTab } from './components/Panel.tsx'
import { VersionPreview } from './components/VersionPreview.tsx'
import type { VersionRow } from './lib/versions.ts'
import { Settings } from './components/Settings.tsx'
import { ThinkingSpace } from './components/ThinkingSpace.tsx'
import { VoicePage } from './components/VoicePage.tsx'
import { Sidebar, type FileActions, type SidebarMode } from './components/Sidebar.tsx'
import { Icon } from './components/Icon.tsx'
import { LimitStatus, textStore } from './components/LimitStatus.tsx'
import { dismissHelp, helpMod, helpShowing, noteCmdWorks } from './editor/help.ts'
import { fieldSlot, type EdgeSlot } from './lib/edge.ts'
import { CaptureBox } from './components/CaptureBox.tsx'
import { IdeasPage } from './components/IdeasPage.tsx'
import { IDEAS_FILE } from './lib/special.ts'
import { mergeClusters, newId, withoutFragment } from './lib/thinking.ts'
import { binding, isMac as isMacKeys, matches, setOverrides, titled, type CommandId } from './lib/keys.ts'
import { isSpecialPath } from './lib/special.ts'
import { authorOf, templateBody, templateMeta, type TemplateInfo } from './lib/templates.ts'
import { StartFrom, TemplatePicker } from './components/TemplatePicker.tsx'
import { insertTemplate, replacePlaceholder } from './editor/prompts.ts'
import { APPEARANCE_DEFAULTS, appearanceVars, newNoteFolder } from './lib/appearance.ts'
import { READ_WPM, readingTimes } from './lib/sentences.ts'

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
  const remembered = useRef(path) // the document open when Ekdanta was last closed
  // Nothing is read until the settings say where to start (see "Where Ekdanta starts").
  const [started, setStarted] = useState(false)
  // What's on screen. `key` changes only when a different document opens, not when one is renamed.
  const [loaded, setLoaded] = useState<(Doc & { key: string; caret?: number | null }) | null>(null)
  // The open document has nothing in its body yet (a new draft can start from a template).
  const [bodyEmpty, setBodyEmpty] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null) // a new draft, whose title gets the caret
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [words, setWords] = useState(0)
  const [saved, setSaved] = useState<'saved' | 'saving' | 'unsaved'>('saved')

  const [sidebarOpen, setSidebarOpen] = usePref('sidebar', true)
  const [sidebarMode, setSidebarMode] = usePref<SidebarMode>('sidebarMode', 'vault')
  const [panelOpen, setPanelOpen] = usePref('panel', true)
  const [panelTab, setPanelTab] = usePref<PanelTab>('panelTab', 'piece')
  const [historySeg, setHistorySeg] = usePref<HistorySeg>('historySeg', 'versions')
  // Version history: a counter that tells the list to re-read, one that opens its name field, and the version being previewed.
  const [versionsTick, setVersionsTick] = useState(0)
  const [versionsAsk, setVersionsAsk] = useState(0)
  const [preview, setPreview] = useState<VersionRow | null>(null)
  const bumpVersions = useCallback(() => setVersionsTick((t) => t + 1), [])
  const [focus, setFocus] = useState(false)
  // The writer's own Page/Markdown choice, remembered between sessions, and the view on screen now.
  // A new draft may open in the other view (Settings · Writing · New documents open in); opening an
  // existing document comes back to the writer's choice, so the new-draft view never becomes the view for everything.
  const [chosenView, setChosenView] = usePref('livePreview', true)
  const [livePreview, setLivePreview] = useState(chosenView)
  const chooseView = useCallback(
    (on: boolean) => {
      setChosenView(on)
      setLivePreview(on)
    },
    [setChosenView],
  )
  const [editor, setEditor] = useState<TiptapEditor | null>(null)
  const [format, setFormat] = useState<EditorFormat | null>(null)
  const [outline, setOutline] = useState<Heading[]>([])
  const [settings, setSettings] = useState<SettingsT | null>(null)
  // Set during render, so everything below sees the current kinds of writing.
  setKinds(settings?.kinds)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [voices, setVoices] = useState<VoiceSummary[]>([])
  const [voiceView, setVoiceView] = useState<string | null>(null) // a platform whose profile fills the page
  const refreshVoices = useCallback(() => api.voice().then(setVoices), [])
  // Ideas: the full-page list, the one-line capture box, and a counter that tells the list to re-read.
  const [ideasView, setIdeasView] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)
  // Where the caret was in ideas.md when a capture re-read it, to put it back on the new page.
  const reselect = useRef<{ from: number; to: number } | null>(null)
  useEffect(() => {
    const sel = reselect.current
    if (!editor || !sel) return
    reselect.current = null
    const max = editor.state.doc.content.size
    editor
      .chain()
      .setTextSelection({ from: Math.min(sel.from, max), to: Math.min(sel.to, max) })
      .focus()
      .run()
  }, [editor])
  const [ideasVersion, setIdeasVersion] = useState(0)
  // How many ideas ideas.md holds, for the Vault's Ideas row: read again after a capture, on switching pages, and on coming back to the app.
  const [ideaCount, setIdeaCount] = useState<number | null>(null)
  const refreshIdeaCount = useCallback(
    () =>
      api
        .ideas()
        .then((d) => setIdeaCount(d.ideas.length))
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    refreshIdeaCount()
  }, [refreshIdeaCount, ideasVersion, ideasView, path])
  useEffect(() => {
    window.addEventListener('focus', refreshIdeaCount)
    return () => window.removeEventListener('focus', refreshIdeaCount)
  }, [refreshIdeaCount])
  const [trash, setTrash] = useState<Trashed[]>([])
  const refreshTrash = useCallback(() => api.trash().then(setTrash), [])
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const notify = useCallback((text: string, undo?: () => void) => {
    window.clearTimeout(toastTimer.current)
    setToast({ text, undo })
    toastTimer.current = window.setTimeout(() => setToast(null), 6000)
  }, [])
  // The open document's Thinking Space, and which of its fragments the draft already uses.
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [thinking, setThinking] = useState<Thinking | null>(null)
  const [material, setMaterial] = useState<{ covered: string[]; nearest: string | null }>({ covered: [], nearest: null })
  // The brief pinned beside the open document ('' for none), tied to the document it was read for: it's
  // null until both have loaded, so the paste box never opens empty over a brief still on its way, and
  // a save always goes to the page the box was opened for. Plus whether its paste box is open.
  const [brief, setBrief] = useState<{ doc: Doc; text: string } | null>(null)
  const [briefEditing, setBriefEditing] = useState(false)
  const briefFor = useRef<string | null>(null) // a page opened from its ⋯ menu to pin a brief
  const paragraph = useRef('')
  const materialTimer = useRef<number | undefined>(undefined)
  const ceiling = settings?.ceiling ?? 5
  const recallDot = settings?.recallDot ?? true
  // Changes show at once; the server's cleaned copy replaces them only if no newer change was made
  // meanwhile (dragging the text size sends many), or an older reply would undo the newer change.
  const settingsSeq = useRef(0)
  const changeSettings = useCallback((patch: Partial<SettingsT>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    const seq = ++settingsSeq.current
    api.saveSettings(patch).then((next) => {
      if (seq === settingsSeq.current) setSettings(next)
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
  /** Whether this server keeps versions at all; see keepVersion. */
  const versions = useRef(true)
  // The open file as text, for the length count; it changes on every keystroke without re-rendering the app.
  const [fileText] = useState(textStore)
  const syncText = useCallback(() => {
    const d = docRef.current
    fileText.set(d ? joinFrontMatter(d.rawMeta, d.meta, d.body) : '')
  }, [fileText])
  const saveTimer = useRef<number | undefined>(undefined)
  const autosaveMs = useRef(APPEARANCE_DEFAULTS.autosaveMs)
  autosaveMs.current = settings?.autosaveMs ?? APPEARANCE_DEFAULTS.autosaveMs
  const renamed = useRef<string | null>(null)
  const opened = useRef(0)

  const refreshFiles = useCallback(() => api.files().then(setFiles), [])
  // The vault's templates. Re-read when the files change (a template may have been added or edited).
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const templatesRef = useRef<TemplateInfo[]>([])
  templatesRef.current = templates
  const refreshTemplates = useCallback(
    () =>
      api
        .templates()
        .then(setTemplates)
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    refreshTemplates()
  }, [files, refreshTemplates])
  useEffect(() => {
    // Settings → Kinds added the starter set.
    const on = () => refreshFiles()
    window.addEventListener('ekdanta:templates', on)
    return () => window.removeEventListener('ekdanta:templates', on)
  }, [refreshFiles])
  // A template picker: for a new piece, for the open draft, or to insert at the caret.
  const [picker, setPicker] = useState<'new' | 'draft' | 'insert' | null>(null)
  // Where the caret goes in a document about to open (a template's {{cursor}}).
  const pendingCaret = useRef<{ path: string; caret: number | null } | null>(null)
  useEffect(() => {
    refreshFiles()
    api.status().then(setStatus)
    api.settings().then(setSettings)
    refreshVoices()
    refreshTrash()
  }, [refreshFiles, refreshVoices, refreshTrash])

  // The writer's own shortcuts, from Settings.
  const [, setKeysVersion] = useState(0)
  useEffect(() => {
    setOverrides(settings?.keys)
    setKeysVersion((v) => v + 1) // so tooltips and labels show the new keys
  }, [settings?.keys])

  // Appearance: follow the system unless the writer picked light or dark.
  useEffect(() => {
    const theme = settings?.theme ?? 'system'
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [settings?.theme])

  // Font, text size, line width and spacing: custom properties on :root, which the page's styles read.
  // The text reflows, so the line at the caret (or at the top of the view) is kept where it was on screen.
  const a = settings ?? APPEARANCE_DEFAULTS
  const vars = appearanceVars({ ...APPEARANCE_DEFAULTS, ...a })
  const varsKey = JSON.stringify(vars) + a.lineWidth
  useLayoutEffect(() => {
    const root = document.documentElement
    const anchor = scrollAnchor()
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    if (a.lineWidth === 'full') root.dataset.measure = 'full'
    else delete root.dataset.measure
    anchor?.restore()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [varsKey])

  // A CSS snippet from the vault, added as a <style>. Re-read when the window comes back, so edits made
  // in another app show up. One that's missing or has no rules we can read is left out, with a notice.
  const [snippetNote, setSnippetNote] = useState<string | null>(null)
  const snippet = settings?.cssSnippet ?? ''
  useEffect(() => {
    let cancelled = false
    const apply = async () => {
      let css = ''
      let note: string | null = null
      if (snippet) {
        try {
          const got = await api.snippet(snippet)
          css = got.css
          if (got.error) note = `${snippet} couldn’t be loaded (${got.error.toLowerCase()}), so it isn’t applied.`
          else if (css.trim() && !cssRules(css)) {
            note = `${snippet} has no rules that could be read, so it isn’t applied.`
            css = ''
          }
        } catch (e) {
          note = `${snippet} couldn’t be loaded (${(e as Error).message.toLowerCase()}), so it isn’t applied.`
        }
      }
      if (cancelled) return
      setSnippetNote(note)
      let el = document.getElementById('ekdanta-snippet')
      if (!css) return el?.remove()
      if (!el) {
        el = document.createElement('style')
        el.id = 'ekdanta-snippet'
        document.head.append(el)
      }
      if (el.textContent !== css) el.textContent = css
    }
    apply()
    window.addEventListener('focus', apply)
    return () => {
      cancelled = true
      window.removeEventListener('focus', apply)
    }
  }, [snippet])

  // Open the remembered document, or the first one in the vault.
  useEffect(() => {
    if (!files.length) return
    if (!path || !files.some((f) => f.path === path)) setPath(files[0].path)
  }, [files, path, setPath])

  useEffect(() => {
    if (!path || !started) return
    if (renamed.current === path) {
      renamed.current = null // same document under a new name: nothing to reload
      return
    }
    let cancelled = false
    if (briefFor.current !== path) briefFor.current = null
    setBrief(null)
    setBriefEditing(false)
    // The page and its brief arrive together (a brief that can't be read stays null: nothing to edit or overwrite).
    Promise.all([api.read(path), api.brief(path).catch(() => null)]).then(([content, b]) => {
      if (cancelled) return
      const { meta, body, raw } = splitFrontMatter(content)
      const d = (docRef.current = { path, meta, body, rawMeta: raw })
      const caret = pendingCaret.current?.path === path ? pendingCaret.current.caret : null
      pendingCaret.current = null
      syncText()
      // A fresh key for every opening: a new untitled.md can reuse the name of a draft just titled and renamed.
      setLoaded({ ...d, key: `${path}#${++opened.current}`, caret })
      setBodyEmpty(!body.trim())
      setSaved('saved')
      if (b !== null) setBrief({ doc: d, text: b })
      // Opened from its ⋯ menu to pin a brief (asked for before or while it loaded).
      if (briefFor.current === path) {
        briefFor.current = null
        setBriefEditing(b !== null)
      }
    })
    api.history(path).then((h) => !cancelled && setHistory(h as HistoryItem[]))
    setThinking(null)
    setMaterial({ covered: [], nearest: null })
    api.thinking(path).then((t) => !cancelled && setThinking(t))
    return () => {
      cancelled = true
    }
  }, [path, started])

  // The open page's brief: only while it belongs to the page on screen (every switch re-renders).
  const openBrief = brief && brief.doc === docRef.current ? brief : null

  const save = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    const d = docRef.current
    if (!d) return
    setSaved('saving')
    // The page forgives `**bold **` while it's being typed; the file always gets valid Markdown.
    await api.write(d.path, joinFrontMatter(d.rawMeta, d.meta, d.body))
    setSaved('saved')
    setVersionsTick((t) => t + 1) // a save can keep a version
  }, [])

  const onChange = useCallback(
    (text: string) => {
      if (docRef.current) docRef.current.body = text
      setBodyEmpty(!text.trim())
      syncText()
      setSaved('unsaved')
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(save, autosaveMs.current)
    },
    [save, syncText],
  )

  /** The open document as it is on screen, front matter included: what a version keeps. */
  const currentText = useCallback(() => {
    const d = docRef.current
    return d ? joinFrontMatter(d.rawMeta, d.meta, d.body) : ''
  }, [])

  /** Keep a version of the text on screen now (before help replaces a lot of it, say). */
  const snapshotNow = useCallback(
    (reason: string) => {
      const d = docRef.current
      if (!d) return
      api
        .snapshot(d.path, { reason, content: currentText() })
        .then(bumpVersions)
        .catch(() => {})
    },
    [currentText, bumpVersions],
  )

  /** Save version…: keep the text as it is, with the writer's name for it if they gave one. */
  const saveVersion = useCallback(
    async (name: string) => {
      const d = docRef.current
      if (!d) return
      if (saveTimer.current !== undefined) await save()
      const { version } = await api.snapshot(d.path, { reason: 'saved by you', name: name || undefined, content: currentText() })
      bumpVersions()
      notify(version ? (name ? `Saved version “${name}”` : 'Saved a version') : 'Nothing new to save · the last version is the same')
    },
    [save, currentText, bumpVersions, notify],
  )

  /** Put a version's text back: saves first, keeps what's there as a version, then replaces the body in one step (⌘Z undoes it). Front matter stays as it is now. */
  const restoreVersion = async (content: string) => {
    const d = docRef.current
    const row = preview
    if (!d) return
    if (saveTimer.current !== undefined) await save()
    await api.snapshot(d.path, { reason: 'before restore', content: currentText() })
    window.dispatchEvent(new CustomEvent('ekdanta:replace-body', { detail: { body: splitFrontMatter(content).body } }))
    await save()
    setPreview(null)
    bumpVersions()
    const at = row ? new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    notify(`Restored ${row?.name ? `“${row.name}”` : `the version from ${at}`} · ${isMacKeys ? '⌘Z' : 'Ctrl+Z'} undoes it`)
  }

  // A preview belongs to the document it was opened on.
  useEffect(() => setPreview(null), [loaded?.key, voiceView])

  /** Switch documents: finish any pending save first, and drop a new draft that was left empty. */
  const openDoc = useCallback(
    async (next: string, newly = false) => {
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
      setIdeasView(false)
      if (!newly) setLivePreview(chosenView)
      setPath(next)
    },
    [save, refreshFiles, setPath, chosenView],
  )

  const newDraft = useCallback(
    async (folder?: string) => {
      const currentFolder = files.find((f) => f.path === docRef.current?.path)?.folder ?? ''
      const target = folder ?? newNoteFolder(settings ?? APPEARANCE_DEFAULTS, { currentFolder, platform: docRef.current?.meta.platform?.toLowerCase(), kinds: kinds() })
      const { path: rel } = await api.create(target)
      await refreshFiles()
      setFresh(rel)
      if (settings) setLivePreview(settings.newDocView !== 'markdown')
      await openDoc(rel, true)
    },
    [files, openDoc, refreshFiles, settings],
  )

  // Where Ekdanta starts: the document open last, or, if the writer turned that off, a fresh draft.
  // An empty draft left from last time is used again rather than piling up untitled files.
  const starting = useRef(false)
  useEffect(() => {
    if (!settings || starting.current) return
    starting.current = true
    const last = remembered.current
    if (settings.openLast) return setStarted(true)
    ;(async () => {
      try {
        if (last && /(^|\/)untitled(-\d+)?\.md$/.test(last)) {
          const { meta, body } = splitFrontMatter(await api.read(last).catch(() => ''))
          if (!meta.title?.trim() && !body.trim() && (await api.files()).some((f) => f.path === last)) {
            setFresh(last)
            if (settings) setLivePreview(settings.newDocView !== 'markdown')
            setPath(last)
            return
          }
        }
        await newDraft()
      } finally {
        setStarted(true)
      }
    })()
  }, [settings, newDraft, setPath])

  const setMeta = (patch: MetaPatch) => {
    const d = docRef.current
    if (!d) return
    d.meta = applyPatch(d.meta, patch)
    syncText()
    setLoaded((l) => (l ? { ...l, meta: d.meta } : l))
    save().then(refreshFiles)
  }

  /** Change front matter of a given file: the open one through the editor's copy, any other on disk. */
  const setMetaOf = async (rel: string, patch: MetaPatch) => {
    if (docRef.current?.path === rel) setMeta(patch)
    else await api.patchMeta(rel, patch).then(refreshFiles)
  }

  /** A title written for the first time also names the file, and fills a template's {{title}} if it's still there. */
  const setTitle = async (title: string) => {
    const d = docRef.current
    if (!d) return
    if (!d.meta.title?.trim() && title.trim() && d.body.includes('{{title}}')) {
      if (editor && livePreview)
        replacePlaceholder(editor, '{{title}}', title) // the page reports the change, which updates d.body
      else {
        d.body = d.body.split('{{title}}').join(title)
        setLoaded((l) => (l ? { ...l, body: d.body, key: l.key + '~' } : l))
      }
    }
    d.meta = { ...d.meta, title }
    setLoaded((l) => (l ? { ...l, meta: d.meta } : l))
    await save()
    follow((await api.name(d.path, title)).path)
    refreshFiles()
  }

  /** A new platform moves the piece into that platform's folder. */
  const setPlatform = async (platform: string) => {
    const d = docRef.current
    if (!d) return
    d.meta = applyPatch(d.meta, { platform })
    setLoaded((l) => (l ? { ...l, meta: d.meta } : l))
    await save()
    follow((await api.place(d.path)).path)
    refreshFiles()
    refreshVoices()
  }

  /** Read the open document again after the server rewrote it, with the caret at `caret` (an offset into the body). */
  const reloadOpen = async (caret: number | null) => {
    const d = docRef.current
    if (!d) return
    const { meta, body, raw } = splitFrontMatter(await api.read(d.path))
    docRef.current = { path: d.path, meta, body, rawMeta: raw }
    setLoaded({ ...docRef.current, key: `${d.path}#${++opened.current}`, caret })
    setBodyEmpty(!body.trim())
    setSaved('saved')
  }

  const templateFailed = (e: unknown) => {
    notify((e as Error).message || 'Template not found')
    refreshTemplates()
  }

  /**
   * Start the open (new, empty) draft from a template. A title typed but not yet committed is kept.
   * On the page the template goes in through the editor, so one Cmd-Z takes it back out again; in the
   * Markdown view, where there is no editor, the server fills the file and the view is read afresh.
   */
  const startFrom = async (t: TemplateInfo) => {
    setPicker(null)
    const d = docRef.current
    if (!d) return
    const typed = (document.querySelector('.doc-title')?.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (typed && typed !== (d.meta.title ?? '')) await setTitle(typed)
    if (saveTimer.current !== undefined) await save()
    const doc = docRef.current
    if (!doc) return
    const ed = editorRef.current
    if (!livePreview || !ed) {
      try {
        const { cursor } = await api.applyTemplate(doc.path, t.path)
        await reloadOpen(cursor)
        refreshFiles()
      } catch (e) {
        templateFailed(e)
      }
      return
    }
    let raw: string
    try {
      raw = await api.read(t.path)
    } catch {
      return templateFailed(new Error('Template not found'))
    }
    // The same guard the server keeps: a piece with writing in it is never overwritten.
    if (docRef.current?.body.trim()) return notify('This piece already has writing in it. Use /template to add a template where the caret is.')
    const kind = (doc.meta.platform ?? '').toLowerCase()
    const ctx = { title: doc.meta.title ?? '', kind: findKind(kinds(), kind) ? platformLabel(kind) : '', author: authorOf(settings), now: new Date() }
    const { text, cursor } = templateBody(raw, ctx)
    insertTemplate(ed, text, cursor)
    // The template's own extra front matter (its kind and name stay behind), as the server would copy it.
    const extras = templateMeta(raw, ctx)
    if (Object.keys(extras).length) setMeta(extras)
    refreshFiles()
  }

  /** A new piece from a template, filed as the template's kind (or where a new draft would go, for a template for any kind). */
  const newFromTemplate = async (t: TemplateInfo) => {
    setPicker(null)
    const kind = findKind(kinds(), t.kind)
    const here = files.find((f) => f.path === docRef.current?.path)?.folder ?? ''
    const folder = kind || isSpecialPath(here) ? '' : here
    let { path: rel } = await api.create(folder, kind?.id)
    if (kind) rel = (await api.place(rel)).path
    let caret: number | null = null
    try {
      caret = (await api.applyTemplate(rel, t.path)).cursor
    } catch (e) {
      templateFailed(e) // the new piece stays blank
    }
    pendingCaret.current = { path: rel, caret }
    await refreshFiles()
    setFresh(rel)
    await openDoc(rel)
  }

  /** Put a template's text in at the caret (the "/" menu), without its front matter. */
  const insertAtCaret = async (t: TemplateInfo) => {
    setPicker(null)
    const ed = editorRef.current
    const d = docRef.current
    if (!ed || !d) return
    let raw: string
    try {
      raw = await api.read(t.path)
    } catch {
      return templateFailed(new Error('Template not found'))
    }
    const kind = (d.meta.platform ?? 'essay').toLowerCase()
    const { text, cursor } = templateBody(raw, { title: d.meta.title ?? '', kind: findKind(kinds(), kind) ? platformLabel(kind) : '', author: authorOf(settings), now: new Date() })
    insertTemplate(ed, text, cursor)
  }

  const seedTemplates = async () => {
    const { added } = await api.seedTemplates()
    await refreshFiles()
    await refreshTemplates()
    if (!added.length) notify('The starter templates are already in templates/')
    return added.length
  }

  /** Re-read the open document's front-matter after the server changed it (a move can set the platform). */
  const reloadMeta = async () => {
    const d = docRef.current
    if (!d) return
    const { meta, raw } = splitFrontMatter(await api.read(d.path))
    d.meta = meta
    d.rawMeta = raw
    setLoaded((l) => (l ? { ...l, meta } : l))
  }

  /** Everything a page's ⋯ menu does. The open page saves first, so nothing typed is lost. */
  const fileActions: FileActions = {
    rename: async (rel, title) => {
      const isOpen = docRef.current?.path === rel
      if (isOpen && saveTimer.current !== undefined) await save()
      const { path: next } = await api.rename(rel, title)
      if (isOpen) {
        follow(next)
        await reloadMeta()
      }
      refreshFiles()
      refreshVoices()
    },
    move: async (rel, folder) => {
      const isOpen = docRef.current?.path === rel
      if (isOpen && saveTimer.current !== undefined) await save()
      const { path: next } = await api.move(rel, folder)
      if (isOpen) {
        follow(next)
        await reloadMeta()
      }
      await refreshFiles()
      refreshVoices()
      notify(`Moved to ${folder.split('/').pop()}`, () => fileActions.move(next, rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''))
    },
    duplicate: async (rel) => {
      if (docRef.current?.path === rel && saveTimer.current !== undefined) await save()
      const { path: next } = await api.duplicate(rel)
      await refreshFiles()
      await openDoc(next)
    },
    remove: async (rel) => {
      const isOpen = docRef.current?.path === rel
      if (isOpen) {
        if (saveTimer.current !== undefined) await save()
        docRef.current = null // nothing left to save to
      }
      const item = await api.remove(rel)
      const left = (await api.files()).filter((f) => f.path !== rel)
      setFiles(left)
      if (isOpen) {
        setLoaded(null)
        if (left.length) openDoc(left[0].path)
      }
      refreshTrash()
      refreshVoices()
      notify(`Deleted “${item.title}”`, () => restore(item.id))
    },
    pinBrief: (rel) => void pinBrief(rel),
    hasBrief: (rel) => (openBrief && rel === openBrief.doc.path ? openBrief.text.trim() !== '' : !!files.find((f) => f.path === rel)?.brief),
  }

  /** Pin a brief to a page (or edit the one it has): open the page, and the paste box in the Piece tab. */
  const pinBrief = async (rel: string) => {
    setPanelOpen(true)
    setPanelTab('piece')
    const d = docRef.current
    // The page on screen, and not one that's still loading in its place.
    if (d?.path === rel && path === rel) {
      if (brief?.doc === d) return setBriefEditing(true)
      // Its brief couldn't be read when the page opened: try again rather than offer an empty box over it.
      const b = await api.brief(rel).catch(() => null)
      if (b === null) return notify('Couldn’t read this page’s brief. Try again in a moment.')
      if (docRef.current !== d) return
      setBrief({ doc: d, text: b })
      return setBriefEditing(true)
    }
    // The paste box opens once the page and its brief have loaded (see the [path] effect).
    briefFor.current = rel
    await openDoc(rel)
  }

  /** Keep the file list's "has a brief" mark in step, for the ⋯ menus of pages that aren't open. */
  const markBrief = (rel: string, on: boolean) => setFiles((fs) => fs.map((f) => (f.path === rel ? { ...f, brief: on } : f)))

  // Save to the page the paste box was opened for (it's only shown while that page is the open one).
  const saveBrief = async (text: string) => {
    const d = brief?.doc
    if (!d) return
    if (!text.trim()) return unpinBrief()
    const saved = await api.pinBrief(d.path, text)
    markBrief(d.path, saved !== '')
    if (docRef.current === d) {
      setBrief({ doc: d, text: saved })
      setBriefEditing(false)
    }
  }

  const unpinBrief = async () => {
    const d = brief?.doc
    if (!d) return
    const was = brief.text
    await api.pinBrief(d.path, '')
    markBrief(d.path, false)
    if (docRef.current === d) setBrief({ doc: d, text: '' })
    setBriefEditing(false)
    if (was)
      notify('Brief unpinned', async () => {
        // A rename since then updates d.path, so the brief goes back to the page wherever it is now.
        try {
          await api.pinBrief(d.path, was)
          markBrief(d.path, true)
          if (docRef.current === d) setBrief({ doc: d, text: was })
        } catch (e) {
          notify(`Couldn’t pin the brief back: ${(e as Error).message}`)
        }
      })
  }

  const restore = async (id: string) => {
    const { path: back } = await api.restore(id)
    await refreshFiles()
    refreshTrash()
    refreshVoices()
    setToast(null)
    openDoc(back)
  }

  /** The open document was renamed or moved: keep editing it under its new path. */
  const follow = (next: string) => {
    const d = docRef.current
    if (!d || next === d.path) return
    const prev = d.path
    d.path = next
    renamed.current = next
    // Rename it in the list now too, or the app would think the open file had gone.
    setFiles((fs) => fs.map((f) => (f.path === prev ? { ...f, path: next, folder: next.includes('/') ? next.slice(0, next.lastIndexOf('/')) : '' } : f)))
    setLoaded((l) => (l ? { ...l, path: next } : l))
    setFresh((f) => (f === prev ? next : f))
    setPath(next)
  }

  /** Settings → Kinds: move a kind's pieces out of a doubled-plural folder, following the open document if it moves. */
  const renameKindFolder = async (id: string) => {
    if (saveTimer.current !== undefined) await save()
    const { settings: next, moved } = await api.renameKindFolder(id)
    setSettings(next)
    const mine = moved.find((m) => m.from === docRef.current?.path)
    if (mine) follow(mine.to)
    await refreshFiles()
  }

  /** ★ a document as an exemplar of its platform, or un-star it. */
  const toggleExemplar = async (rel: string) => {
    const f = files.find((x) => x.path === rel)
    if (!f) return
    const patch = { exemplar: f.exemplar ? null : 'true' }
    setFiles((fs) => fs.map((x) => (x.path === rel ? { ...x, exemplar: !x.exemplar } : x)))
    // The open document saves through the editor, so its front-matter must change there too.
    await setMetaOf(rel, patch)
    refreshVoices() // the profile for this platform is now out of date
  }

  const openVoice = (platform: string) => {
    refreshVoices()
    setIdeasView(false)
    setVoiceView(platform)
  }

  const openIdeas = () => {
    setVoiceView(null)
    setIdeasView(true)
  }

  /** Add an idea to ideas.md. If ideas.md is the open page, it's saved first and re-read after, so neither edit is lost. */
  const captureIdea = async (text: string) => {
    const d = docRef.current
    const isOpen = d?.path.toLowerCase() === IDEAS_FILE
    if (isOpen && saveTimer.current !== undefined) await save()
    const { added } = await api.captureIdea(text)
    if (isOpen && added && docRef.current === d) {
      // The line goes at the end, so the caret's place is unchanged: put it back once the page is re-read.
      const sel = editor && !editor.isDestroyed ? editor.state.selection : null
      reselect.current = sel ? { from: sel.from, to: sel.to } : null
      const { meta, body, raw } = splitFrontMatter(await api.read(d.path))
      docRef.current = { path: d.path, meta, body, rawMeta: raw }
      setLoaded({ ...docRef.current, key: `${d.path}#${Date.now()}` })
    }
    if (added && !files.some((f) => f.path.toLowerCase() === IDEAS_FILE)) refreshFiles()
    setIdeasVersion((v) => v + 1)
    notify(added ? 'Saved to Ideas' : 'Already in Ideas today')
  }

  /** Begin a piece of a kind from an idea, and open it with the caret in its title. */
  const startIdea = async (text: string, kind: string) => {
    try {
      const { path: rel } = await api.startIdea(text, kind)
      await refreshFiles()
      setFresh(rel)
      await openDoc(rel)
    } catch (e) {
      notify(`Couldn't start it: ${(e as Error).message}`)
    }
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
        api
          .thinkingMaterial(d.path, frags, paragraph.current)
          .then(setMaterial)
          .catch(() => {})
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

  /** Change the Thinking Space from the panel, without opening it. */
  const changeThinking = (change: (t: Thinking) => Thinking) => {
    const doc = docRef.current?.path
    if (!doc) return
    setThinking((prev) => {
      const next = change(prev ?? { canvas: { nodes: [], edges: [] }, side: {} })
      api.saveThinking(doc, next)
      return next
    })
  }

  /** Look for a note of the writer's that matches a thought, as the canvas does after a pause. */
  const recallFor = async (id: string, text: string) => {
    const doc = docRef.current?.path
    if (!doc) return
    const taken = Object.entries(thinking?.side.recall ?? {}).flatMap(([k, r]) => (r.hit && k !== id ? [r.hit.doc] : []))
    try {
      const { chips } = await api.thinkingRecall(doc, [{ id, text }], taken)
      if (docRef.current?.path !== doc) return
      changeThinking((t) => ({ ...t, side: { ...t.side, recall: { ...t.side.recall, [id]: { text, hit: chips[id] ?? null } } } }))
    } catch {
      /* Recall isn't ready: the thought is kept all the same */
    }
  }

  const thoughts = {
    /** A thought typed into the panel goes onto the canvas, below the others. */
    add: (text: string) => {
      const id = newId()
      changeThinking((t) => {
        const texts = t.canvas.nodes.filter((n) => n.type === 'text')
        const x = texts.length ? Math.min(...texts.map((n) => n.x)) : 120
        const y = texts.length ? Math.max(...texts.map((n) => n.y + n.height)) + 24 : 96
        const node = { id, type: 'text', text, x: Math.round(x), y: Math.round(y), width: Math.min(320, Math.round(40 + text.length * 7.5)), height: 30 }
        return { ...t, canvas: { ...t.canvas, nodes: [...t.canvas.nodes, node] } }
      })
      recallFor(id, text)
    },
    edit: (id: string, text: string) => {
      if (!text.trim()) return thoughts.remove(id)
      changeThinking((t) => ({ ...t, canvas: { ...t.canvas, nodes: t.canvas.nodes.map((n) => (n.id === id ? { ...n, text } : n)) } }))
      recallFor(id, text)
    },
    remove: (id: string) => {
      const before = thinking
      changeThinking((t) => withoutFragment(t, id))
      if (before) notify('Thought removed', () => changeThinking(() => before))
    },
    /** Tick a fragment off by hand, or un-tick one the draft seemed to cover. */
    check: (id: string, done: boolean) =>
      changeThinking((t) => {
        const checked = { ...t.side.checked }
        // Back to what the draft shows: no need to remember it.
        if (done === material.covered.includes(id)) delete checked[id]
        else checked[id] = done
        return { ...t, side: { ...t.side, checked } }
      }),
    cluster: async () => {
      const frags = (thinking?.canvas.nodes ?? []).filter((n) => n.type === 'text' && n.text?.trim()).map((n) => ({ id: n.id, text: n.text! }))
      const { clusters } = await api.thinkingClusters(frags)
      changeThinking((t) => ({ ...t, side: { ...t.side, clusters: mergeClusters(t.side.clusters, clusters) } }))
    },
    ungroup: () => changeThinking((t) => ({ ...t, side: { ...t.side, clusters: [] } })),
    renameGroup: (id: string, label: string) => changeThinking((t) => ({ ...t, side: { ...t.side, clusters: t.side.clusters?.map((c) => (c.id === id ? { ...c, label, mine: true } : c)) } })),
  }

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

  const record = useCallback((item: HistoryItem) => {
    const d = docRef.current
    if (!d) return
    setHistory((h) => [...h, item])
    api.appendHistory(d.path, item)
  }, [])

  // Window-level shortcuts. Each app command is one line here; the first whose key matches runs.
  useEffect(() => {
    const openTab = (tab: 'material' | 'outline' | 'history' | 'piece') => {
      setPanelOpen(true)
      setPanelTab(tab)
    }
    const appActions: Partial<Record<CommandId, () => void>> = {
      focus: () => setFocus((f) => !f),
      panel: () => setPanelOpen((o) => !o),
      save: () => save(),
      star: () => void (docRef.current && toggleExemplar(docRef.current.path)),
      settings: () => setSettingsOpen((o) => !o),
      newDraft: () => newDraft(),
      newFromTemplate: () => setPicker('new'),
      // The Thinking Space closes itself with the same key.
      thinking: () => {
        if (docRef.current && !thinkingOpen) {
          if (saveTimer.current !== undefined) save()
          setThinkingOpen(true)
        }
      },
      material: () => openTab('material'),
      outline: () => openTab('outline'),
      history: () => openTab('history'),
      piece: () => openTab('piece'),
      versions: () => {
        openTab('history')
        setHistorySeg('versions')
      },
      saveVersion: () => {
        if (!docRef.current) return
        openTab('history')
        setHistorySeg('versions')
        setVersionsAsk((a) => a + 1)
      },
      dismissHelp: () => void dismissHelp(),
      brief: () => void (docRef.current && pinBrief(docRef.current.path)),
      readAloud: () => (livePreview ? window.dispatchEvent(new Event('ekdanta:read-aloud')) : notify('Read aloud works on the page, not in the Markdown view')),
      captureIdea: () => setCaptureOpen((o) => !o),
      ideas: () => openIdeas(),
    }
    const onKey = (e: KeyboardEvent) => {
      // The editor dismisses help itself; from the panel or a card's buttons, ⌘0 and Esc do it here.
      const fromAside = (e.target as Element | null)?.closest?.('.panel, .hl-card, .hl-nudge, .hl-bar, .hl-line')
      // Already handled by the editor, or nothing to dismiss: leave the key alone (⌘0 resets the zoom).
      if (matches(e, binding('dismissHelp')) && (e.defaultPrevented || !helpShowing())) return
      if (e.key === 'Escape' && fromAside && !e.defaultPrevented && dismissHelp()) return e.preventDefault()
      if (focus && e.key === 'Escape' && !document.querySelector('.hl-card, .hl-line, .hl-nudge, .hl-bar, .cm-ins, .hl-ghost')) return setFocus(false)
      for (const [id, action] of Object.entries(appActions)) {
        if (action && matches(e, binding(id))) {
          e.preventDefault()
          action()
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, save, newDraft, setPanelOpen, setPanelTab, setHistorySeg, files, thinkingOpen, livePreview, notify])

  const current = files.find((f) => f.path === path)
  const platform = (loaded?.meta.platform ?? current?.platform ?? 'essay').toLowerCase()
  const title = loaded ? (loaded.meta.title ?? current?.title ?? '') : ''
  const isNew = !!loaded && fresh === loaded.path
  const editorRef = useRef<TiptapEditor | null>(null)
  editorRef.current = editor
  const templateItems = useMemo(() => ({ list: () => templatesRef.current, insert: (t: TemplateInfo) => insertAtCaretRef.current(t), browse: () => setPicker('insert') }), [])
  const insertAtCaretRef = useRef(insertAtCaret)
  insertAtCaretRef.current = insertAtCaret

  // Links between pages use the file name, as Obsidian does: [[on-being-edited]].
  const pagesRef = useRef<PageRef[]>([])
  pagesRef.current = files.map((f) => ({ target: f.path.replace(/\.md$/, '').split('/').pop()!, title: f.title, folder: f.folder }))

  /** The page a [[link]] names, for counting it as the title it shows. */
  const pageFor = useCallback(
    (target: string) => {
      const hit = files.find((f) => f.path.replace(/\.md$/, '') === target || f.path.replace(/\.md$/, '').split('/').pop() === target)
      return hit ? { title: hit.title, path: hit.path } : null
    },
    [files],
  )

  /** Follow a [[link]]. A link to a page that doesn't exist yet creates it, as in Obsidian. */
  const openPage = useCallback(
    async (target: string) => {
      const hit = files.find((f) => f.path.replace(/\.md$/, '') === target || f.path.replace(/\.md$/, '').split('/').pop() === target)
      if (hit) return openDoc(hit.path)
      const folder = files.find((f) => f.path === docRef.current?.path)?.folder ?? ''
      const { path: created } = await api.create(folder)
      const title = target.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
      await api.patchMeta(created, { title })
      // Keep the name the link uses, so the link finds it.
      const { path: named } = await api.rename(created, title)
      await refreshFiles()
      openDoc(named)
    },
    [files, openDoc, refreshFiles],
  )

  /** Images are linked relative to the document, and served from the vault. */
  const assetUrl = useCallback((src: string) => {
    if (/^(https?:|data:)/i.test(src)) return src
    const doc = docRef.current?.path ?? ''
    const parts = (doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/')).split('/') : []).concat(decodeURI(src).split('/'))
    const out: string[] = []
    for (const part of parts) {
      if (part === '..') out.pop()
      else if (part && part !== '.') out.push(part)
    }
    return '/api/asset?path=' + encodeURIComponent(out.join('/'))
  }, [])

  const saveImage = useCallback(async (name: string, data: string) => (await api.saveImage(docRef.current?.path ?? '', name, data)).src, [])

  /**
   * Keep a version of the text on screen, for version history. Without it (an older server) the
   * request fails quietly: the change itself can still be undone with ⌘Z.
   */
  /**
   * Keep a copy of the text as it is now, so a big change can be stepped back to. The version store is
   * the version-history feature's; until that lands this server answers 404, so the first refusal turns
   * the asking off for the rest of the session instead of a failed request per move. (Once version
   * history is merged this can call its shared api helper, which makes the same request.)
   */
  const keepVersion = (reason: string) => {
    const d = docRef.current
    if (!d || !versions.current) return
    fetch('/api/versions/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: d.path, reason, content: joinFrontMatter(d.rawMeta, d.meta, d.body) }),
    })
      .then((r) => {
        if (r.status === 404 || r.status === 501) versions.current = false
      })
      .catch(() => {})
  }

  /** Put the caret on a heading from the Outline. */
  const goToHeading = (h: Heading) => {
    if (!editor) return
    // The end of the heading's text.
    const node = editor.state.doc.nodeAt(h.pos)
    editor
      .chain()
      .focus()
      .setTextSelection(h.pos + (node?.nodeSize ?? 2) - 1)
      .scrollIntoView()
      .run()
  }

  /** Edge lines: what a slot says now, and where an accepted one goes. */
  const edgeCurrent = (slot: EdgeSlot) => {
    const meta = docRef.current?.meta ?? {}
    return slot === 'title' ? (meta.title ?? '') : slot === 'subject' || slot === 'excerpt' ? (meta[slot] ?? '') : ''
  }
  const acceptEdge = (slot: EdgeSlot, text: string) => {
    if (slot === 'title') setTitle(text)
    else if (slot === 'subject' || slot === 'excerpt') setMeta({ [slot]: text })
  }

  const editorProps = useMemo(
    () => ({
      doc: () => docRef.current?.path ?? '',
      platform: () => (docRef.current?.meta.platform ?? 'essay').toLowerCase(),
      ceiling: () => ceiling,
      recallDot: () => recallDot && !focus,
    }),
    [path, ceiling, recallDot, focus],
  )
  const spellcheck = settings?.spellcheck ?? true
  const folders = useMemo(
    () => [...new Set(files.flatMap((f) => f.folder.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))).filter(Boolean))].sort((x, y) => x.localeCompare(y)),
    [files],
  )

  return (
    <div className={`app${focus ? ' is-focus' : ''}${panelOpen ? ' has-panel' : ''}${sidebarOpen ? ' has-sidebar' : ''}${settings?.paragraphFocus === false ? ' no-para-focus' : ''}`}>
      <header className="titlebar">
        <div className="crumb">
          {current?.folder ? <span className="muted">{current.folder} / </span> : null}
          <b>{title || 'Untitled'}</b>
        </div>
        <div className="titlebar-meta">
          <span className={`save-state is-${saved}`}>{saved === 'saved' ? 'Saved' : saved === 'saving' ? 'Saving…' : 'Edited'}</span>
          <button className="icon-btn" title={titled('Focus mode', 'focus')} onClick={() => setFocus(true)}>
            <Icon name="focus" />
          </button>
          <button className="icon-btn" title={titled('Right panel', 'panel')} onClick={() => setPanelOpen((o) => !o)}>
            <Icon name="panel" />
          </button>
        </div>
      </header>

      <nav className="rail" aria-label="Main">
        <button className="rail-btn" title={titled('New draft', 'newDraft')} onClick={() => newDraft()}>
          <Icon name="compose" />
        </button>
        {/* Toggles like the shortcut; the mousedown leaves focus where the writer was, so the box can return it. */}
        <button className="rail-btn" title={titled('Capture idea', 'captureIdea')} data-capture-toggle onMouseDown={(e) => e.preventDefault()} onClick={() => setCaptureOpen((o) => !o)}>
          <Icon name="idea" />
        </button>
        <span className="rail-sep" />
        <button className={`rail-btn${sidebarOpen && sidebarMode === 'vault' ? ' is-on' : ''}`} title="Vault" onClick={() => showSidebar('vault')}>
          <Icon name="folder" />
        </button>
        <button className={`rail-btn${sidebarOpen && sidebarMode === 'exemplars' ? ' is-on' : ''}`} title="Exemplars" onClick={() => showSidebar('exemplars')}>
          <Icon name="star" />
        </button>
        <button className={`rail-btn${sidebarOpen && sidebarMode === 'voice' ? ' is-on' : ''}`} title="Voice" onClick={() => showSidebar('voice')}>
          <Icon name="voice" />
        </button>
        <div className="rail-spacer" />
        <button className="rail-btn" title={titled('Focus mode', 'focus')} onClick={() => setFocus(true)}>
          <Icon name="focus" />
        </button>
        <button className={`rail-btn${settingsOpen ? ' is-on' : ''}`} title={titled('Settings', 'settings')} onClick={() => setSettingsOpen((o) => !o)}>
          <Icon name="settings" />
        </button>
      </nav>

      {sidebarOpen && (
        <Sidebar
          mode={sidebarMode}
          files={files}
          voices={voices}
          voiceView={voiceView}
          onVoice={openVoice}
          current={voiceView || ideasView ? null : path}
          ideasOpen={ideasView && !voiceView}
          ideaCount={ideaCount}
          onIdeas={openIdeas}
          onCaptureIdea={() => setCaptureOpen(true)}
          onOpen={openDoc}
          onCreate={newDraft}
          onStar={toggleExemplar}
          actions={fileActions}
          trash={trash}
          onRestore={restore}
        />
      )}

      <main className="page-area">
        {voiceView && <VoicePage platform={voiceView} summary={voices.find((v) => v.platform === voiceView)} onOpenDoc={openDoc} onChanged={refreshVoices} />}
        {ideasView && !voiceView && <IdeasPage version={ideasVersion} onCapture={captureIdea} onStart={startIdea} onOpenDoc={openDoc} />}
        {loaded && !voiceView && !ideasView && !focus && <Toolbar editor={editor} format={format} livePreview={livePreview} onLivePreview={chooseView} />}
        {loaded && !voiceView && !ideasView && (
          <div className="page">
            <div className="doc-meta">
              <label className="platform">
                <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Kind of writing">
                  {(kinds().some((k) => k.id === platform) ? kinds().map((k) => k.id) : [...kinds().map((k) => k.id), platform]).map((p) => (
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
            <TitleField
              key={'title:' + loaded.key}
              spellcheck={spellcheck}
              value={loaded.meta.title ?? (current?.title === 'Untitled' ? '' : title)}
              autoFocus={isNew && loaded.caret == null}
              onCommit={setTitle}
              onHelp={livePreview ? (level) => window.dispatchEvent(new CustomEvent('ekdanta:help', { detail: { level } })) : undefined}
            />
            {isNew && !words && <PlatformPicker value={platform} onPick={setPlatform} />}
            {isNew && bodyEmpty && templates.length > 0 && (
              <StartFrom templates={templates} platform={platform} preferred={findKind(kinds(), platform)?.template} onApply={startFrom} onAll={() => setPicker('draft')} />
            )}
            {livePreview ? (
              <Editor
                // Back from the Markdown view, the page is read afresh from what was written there.
                key={loaded.key}
                docKey={loaded.key}
                // Opened to pin a brief: the paste box keeps the focus.
                autoFocus={!isNew && !briefEditing}
                caret={loaded.caret}
                templates={templateItems}
                initial={docRef.current?.body ?? loaded.body}
                onChange={onChange}
                {...editorProps}
                record={record}
                snapshot={snapshotNow}
                openDoc={openDoc}
                onWordCount={setWords}
                onParagraph={onParagraph}
                pages={() => pagesRef.current}
                openPage={openPage}
                saveImage={saveImage}
                assetUrl={assetUrl}
                onEditor={setEditor}
                onFormat={setFormat}
                onOutline={setOutline}
                spellcheck={spellcheck}
                lang={() => docRef.current?.meta.lang}
                onReadUnavailable={() => notify('This browser has no voices to read aloud with. Settings → Writing explains.')}
                edgeCurrent={edgeCurrent}
                acceptEdge={acceptEdge}
              />
            ) : (
              <SourceEditor key={loaded.key + ':md'} initial={docRef.current?.body ?? loaded.body} onChange={onChange} spellcheck={spellcheck} />
            )}
          </div>
        )}
        {focus && <div className="focus-hint">esc or ⌘. to exit focus</div>}
      </main>
      {preview && loaded && !voiceView && (
        <VersionPreview key={preview.id} doc={loaded.path} row={preview} current={currentText} onRestore={restoreVersion} onNamed={bumpVersions} onClose={() => setPreview(null)} />
      )}

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
          field={(() => {
            const f = fieldSlot(platform)
            return f && loaded ? { ...f, value: loaded.meta[f.key] ?? '', canSuggest: livePreview, onChange: (v: string) => setMeta({ [f.key]: v || null }) } : null
          })()}
          recallDot={recallDot}
          onRecallDot={(recallDot) => changeSettings({ recallDot })}
          status={status}
          path={loaded?.path ?? path}
          exemplar={!!current?.exemplar}
          voice={voices.find((v) => v.platform === platform)}
          onVoice={() => openVoice(platform)}
          outline={outline}
          onHeading={goToHeading}
          editor={editor}
          onBeforeMove={() => keepVersion('before moving text in the outline')}
          notify={notify}
          thinking={thinking}
          covered={material.covered}
          nearest={material.nearest}
          onThinking={() => setThinkingOpen(true)}
          thoughts={thoughts}
          onOpenDoc={openDoc}
          onExemplar={() => current && toggleExemplar(current.path)}
          onClearHistory={() => {
            if (!docRef.current) return
            api.clearHistory(docRef.current.path).then(() => setHistory([]))
          }}
          historySeg={historySeg}
          onHistorySeg={setHistorySeg}
          versions={{ tick: versionsTick, ask: versionsAsk, open: preview?.id ?? null, onSave: saveVersion, onOpen: setPreview }}
          brief={openBrief?.text ?? ''}
          briefEditing={briefEditing && !!openBrief}
          onBriefEditing={setBriefEditing}
          onBriefSave={saveBrief}
          onBriefUnpin={unpinBrief}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              onClick={() => {
                toast.undo!()
                setToast(null)
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
      {captureOpen && <CaptureBox onCapture={captureIdea} onClose={() => setCaptureOpen(false)} />}
      {thinkingOpen && loaded && <ThinkingSpace doc={loaded.path} title={title} onClose={closeThinking} />}

      {picker && (
        <TemplatePicker
          title={picker === 'new' ? 'New from template' : picker === 'draft' ? 'Start from a template' : 'Insert a template'}
          templates={templates}
          kinds={kinds()}
          onPick={picker === 'new' ? newFromTemplate : picker === 'draft' ? startFrom : insertAtCaret}
          onClose={() => {
            setPicker(null)
            if (picker !== 'new') editorRef.current?.commands.focus()
          }}
          onSeed={seedTemplates}
        />
      )}

      {settingsOpen && settings && (
        <Settings
          settings={settings}
          status={status}
          onChange={changeSettings}
          onClose={() => setSettingsOpen(false)}
          onRenameKindFolder={renameKindFolder}
          folders={folders}
          snippetNote={snippetNote}
        />
      )}

      <footer className="statusbar">
        <span>
          {platformLabel(platform)} · Ceiling {ceiling}
          {/* The count is the writer's to hide (Settings · Appearance), but a limit they set themselves stays, so they can still see when they're over it. */}
          {(settings?.wordCount !== false || !!loaded?.meta.target) && (
            <>
              {' · '}
              <span className="word-count" title={readingTimes(format?.selectedWords || words) || undefined}>
                {loaded && !voiceView ? (
                  <LimitStatus
                    key={loaded.key}
                    store={fileText}
                    target={loaded.meta.target ?? ''}
                    selectedWords={format?.selectedWords ?? 0}
                    ceiling={ceiling}
                    mod={mod}
                    paper={loaded.meta.paper === 'a4' ? 'a4' : 'letter'}
                    page={pageFor}
                    // Bound to this file: a limit saved as the sheet closes lands here even if another file is opening.
                    onTarget={(target) => setMetaOf(loaded.path, { target })}
                  />
                ) : format?.selectedWords ? (
                  `${format.selectedWords.toLocaleString()} of ${words.toLocaleString()} words`
                ) : (
                  `${words.toLocaleString()} words`
                )}
                {settings?.wordCount !== false && words >= 60 && ` · ${Math.max(1, Math.round(words / READ_WPM))} min read`}
              </span>
            </>
          )}
        </span>
        <span className="muted">
          {mod}1 Recall · {mod}2 Nudge · {mod}3 Word · {mod}4 Sentence · {mod}5 Passage
        </span>
      </footer>
    </div>
  )
}

const platformLabel = (p: string) => kindName(kinds(), p)

/** The document title, edited in place. Return or ↓ moves on to the text. */
function TitleField({ value, autoFocus, spellcheck, onCommit, onHelp }: { value: string; autoFocus: boolean; spellcheck: boolean; onCommit: (t: string) => void; onHelp?: (level: number) => void }) {
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
      spellCheck={spellcheck}
      suppressContentEditableWarning
      role="textbox"
      aria-label="Title"
      data-placeholder="Untitled"
      onBlur={commit}
      onKeyDown={(e) => {
        // A help key never types into the title (⌥3 is # on a Mac). ⌘3 may draw a title from the draft;
        // the others run in the text. The title is committed first, so it's current when help reads it.
        const level = onHelp ? helpLevel(e.nativeEvent) : null
        if (level) {
          e.preventDefault()
          if (e.metaKey) noteCmdWorks()
          commit()
          onHelp!(level)
          return
        }
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

/** From the title down into the text (the page, or the Markdown view). */
function focusText() {
  document.querySelector<HTMLElement>('.editor .pm, .editor .cm-content')?.focus()
}

/** On a new document: which kind it is. The folder's usual one is already chosen. Picking keeps the cursor where it was (the title). */
function PlatformPicker({ value, onPick }: { value: string; onPick: (p: string) => void }) {
  return (
    <div className="platform-picker" role="radiogroup" aria-label="Kind of writing">
      <span className="muted">For</span>
      {kinds().map(({ id: p }) => (
        <button key={p} role="radio" aria-checked={p === value} tabIndex={-1} className={p === value ? 'is-on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(p)}>
          {platformLabel(p)}
        </button>
      ))}
    </div>
  )
}

/**
 * Where the text under the caret (or at the top of the view) sits on screen, and a way to put it
 * back there after the page reflows, so a new text size or column width doesn't throw you elsewhere.
 */
function scrollAnchor() {
  const area = document.querySelector<HTMLElement>('.page-area')
  if (!area) return null
  const view = area.getBoundingClientRect()
  const inView = (y: number) => y >= view.top && y <= view.bottom
  // The caret itself, when it's on screen: its line is what the writer is looking at.
  let measure: (() => number | null) | null = null
  const sel = window.getSelection()
  if (sel?.rangeCount && area.contains(sel.focusNode)) {
    const range = sel.getRangeAt(0).cloneRange()
    range.collapse(false)
    const caretTop = () => {
      const r = range.getClientRects()[0] ?? range.getBoundingClientRect()
      return r && (r.top || r.bottom) ? r.top : null
    }
    const top = caretTop()
    if (top !== null && inView(top)) measure = caretTop
  }
  if (!measure) {
    // Otherwise the first block at the top of the view.
    for (const b of area.querySelectorAll('.pm > *, .cm-line')) {
      if (b.getBoundingClientRect().bottom > view.top) {
        measure = () => (b.isConnected ? b.getBoundingClientRect().top : null)
        break
      }
    }
  }
  const before = measure?.()
  if (!measure || before == null) return null
  return {
    restore() {
      const after = measure() // reading this lays out the page with the new values
      if (after != null && Math.abs(after - before) > 0.5) area.scrollTop += after - before
    },
  }
}

/** How many rules the browser reads from a stylesheet's text (0 when none of it is CSS). */
function cssRules(css: string) {
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    return sheet.cssRules.length
  } catch {
    return 1 // can't tell here: let the browser apply what it can
  }
}
