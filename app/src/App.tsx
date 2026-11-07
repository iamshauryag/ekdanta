import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Editor as TiptapEditor } from '@tiptap/core'
import { Editor, type EditorFormat, type Heading } from './editor/Editor.tsx'
import type { PageRef } from './editor/menus.ts'
import { SourceEditor } from './editor/Source.tsx'
import { findKind, kindName, kinds, setKinds } from './lib/kinds.ts'
import { DocumentMode, DocumentPanel } from './components/DocumentMode.tsx'
import { docOf, dueLabel, kindSwitchPatch, usesDocument } from './lib/docstyle.ts'
import { countable, type Block } from './lib/targets.ts'
import { Toolbar } from './components/Toolbar.tsx'
import type { HistoryItem } from './editor/controller.ts'
import { api, ApiError, type Changes, type FileEntry, type Settings as SettingsT, type Status, type Thinking, type Touched, type Trashed, type VoiceSummary } from './lib/api.ts'
import { joinDoc, patchFrontMatter, splitFrontMatter, type FrontMatter, type MetaPatch } from './lib/frontmatter.ts'
import { docTags, vaultTagCounts } from './lib/tags.ts'
import { Properties } from './components/Properties.tsx'
import { Panel, type HistorySeg, type PanelTab } from './components/Panel.tsx'
import { VersionPreview } from './components/VersionPreview.tsx'
import type { VersionRow } from './lib/versions.ts'
import { Settings } from './components/Settings.tsx'
import { ExportSheet } from './components/ExportSheet.tsx'
import { ThinkingSpace } from './components/ThinkingSpace.tsx'
import { VoicePage } from './components/VoicePage.tsx'
import { MoreMenu } from './components/MoreMenu.tsx'
import { SparksPage } from './components/SparksPage.tsx'
import { BrainPage } from './components/BrainPage.tsx'
import { DEFAULT_BRAIN_FOLDER, STATUS_LABELS, TYPE_LABELS, asStatus, isBrainPath, typeOf } from './lib/brain.ts'
import { Sidebar, type FileActions, type SidebarMode } from './components/Sidebar.tsx'
import { Icon } from './components/Icon.tsx'
import { helpLevel, type Level } from './editor/caret.ts'
import { ImportSheet } from './components/ImportSheet.tsx'
import { VaultError, Welcome } from './components/Welcome.tsx'
import { LimitStatus, textStore } from './components/LimitStatus.tsx'
import { dismissHelp, helpMod, helpShowing, noteCmdWorks } from './editor/help.ts'
import { fieldSlot, type EdgeSlot } from './lib/edge.ts'
import { CaptureBox } from './components/CaptureBox.tsx'
import { IdeasPage } from './components/IdeasPage.tsx'
import { IDEAS_FILE, isSpecialFile, isSpecialPath } from './lib/special.ts'
import type { Reading } from './components/ReaderList.tsx'
import { mergeClusters, newId, withoutFragment } from './lib/thinking.ts'
import { COMMANDS, binding, isMac as isMacKeys, matches, setOverrides, titled, type CommandId } from './lib/keys.ts'
import { authorOf, templateBody, templateMeta, type TemplateInfo } from './lib/templates.ts'
import { StartFrom, TemplatePicker } from './components/TemplatePicker.tsx'
import { insertTemplate, replacePlaceholder } from './editor/prompts.ts'
import { APPEARANCE_DEFAULTS, appearanceVars, newNoteFolder } from './lib/appearance.ts'
import { READ_WPM, readingTimes } from './lib/sentences.ts'
import { Saver, createQueue, draftToOffer, dropDraft, rebase, retryDelay, writeDraft, type Draft, type SaveState, type Store } from './lib/saver.ts'
import { CompareModal, ConflictBar, NoticeBar } from './components/ConflictBar.tsx'

/** This browser's storage, if it has any (a private window or blocked site data may not). */
function browserStore(): Store | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
import { runCommand } from './editor/commands.ts'
import { searchKey, searchState, setSearch } from './editor/search.ts'
import { pushRecent } from './lib/fuzzy.ts'
import { Palette } from './components/Palette.tsx'
import { Switcher } from './components/Switcher.tsx'
import type { SearchState } from './components/SearchPane.tsx'

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

/** A help card, ghost or proposal is on the page: the palette and switcher wait until it's dealt with. */
const HELP_OPEN = '.hl-card, .hl-line, .hl-nudge, .hl-bar, .cm-ins, .hl-ghost'

/** The open document: its front matter as parsed (kept so it's written back as it was found) and its body. */
interface Doc extends FrontMatter {
  path: string
}

/** Said when a change would need front matter that Ekdanta reads but can't rewrite. */
const READONLY_META = "This page's front matter can't be edited in Ekdanta, so it stays exactly as it is. Open Properties to see why."

export function App() {
  const [files, setFiles] = useState<FileEntry[]>([])
  // The pages the writer sees in the vault, without the app's own material files (ideas.md).
  const pages = useMemo(() => files.filter((f) => !isSpecialFile(f.path)), [files])
  const [status, setStatus] = useState<Status | null>(null)
  const statusRef = useRef<Status | null>(null)
  statusRef.current = status
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
  const [saved, setSaved] = useState<SaveState>('saved')
  // The file changed on disk under unsaved text: their version, until the writer picks one.
  const [conflict, setConflict] = useState<{ path: string; mtime: number; content: string } | null>(null)
  // Text kept in this browser from a save that never landed, offered when its document opens.
  const [offer, setOffer] = useState<(Draft & { path: string }) | null>(null)
  // What a screen reader hears about saving: only a save going wrong, and coming right again.
  const [saveNews, setSaveNews] = useState('')
  // A document that couldn't be read because the server didn't answer: it's tried again until it can be.
  const [openFailed, setOpenFailed] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<Block[]>([])
  // Pages the text fills in page view (an estimate), and the document whose Document layout popover is open.
  const [sheetPages, setSheetPages] = useState<{ total: number; body: number } | null>(null)
  const [layoutFor, setLayoutFor] = useState<string | null>(null)

  const [sidebarOpen, setSidebarOpen] = usePref('sidebar', true)
  const [sidebarMode, setSidebarMode] = usePref<SidebarMode>('sidebarMode', 'vault')
  const [panelOpen, setPanelOpen] = usePref('panel', true)
  const [propsOpen, setPropsOpen] = usePref('properties', false)
  const [panelTab, setPanelTab] = usePref<PanelTab>('panelTab', 'piece')
  const [historySeg, setHistorySeg] = usePref<HistorySeg>('historySeg', 'versions')
  // Version history: a counter that tells the list to re-read, one that opens its name field, and the version being previewed.
  const [versionsTick, setVersionsTick] = useState(0)
  const [versionsAsk, setVersionsAsk] = useState(0)
  const [preview, setPreview] = useState<VersionRow | null>(null)
  const bumpVersions = useCallback(() => setVersionsTick((t) => t + 1), [])
  const [focus, setFocus] = useState(false)
  // Navigate: the command palette and quick switcher (one at a time), and the search pane's state.
  const [overlay, setOverlay] = useState<null | 'palette' | 'switcher'>(null)
  const [recentCommands, setRecentCommands] = usePref<string[]>('recentCommands', [])
  const [recentDocs, setRecentDocs] = usePref<string[]>('recentDocs', [])
  const [search, setSearchState] = useState<SearchState>({ query: '', matchCase: false, meaning: false })
  const [searchFocus, setSearchFocus] = useState(0)
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
  const editorRef = useRef<TiptapEditor | null>(null)
  editorRef.current = editor
  const [format, setFormat] = useState<EditorFormat | null>(null)
  const [outline, setOutline] = useState<Heading[]>([])
  const [settings, setSettings] = useState<SettingsT | null>(null)
  // Set during render, so everything below sees the current kinds of writing.
  setKinds(settings?.kinds)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null) // the document the Export sheet is for
  const closeExport = useCallback(() => setExporting(null), [])
  // Something the server couldn't do, shown in a banner over the page until dismissed.
  const [error, setError] = useState<string | null>(null)
  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), [])
  const [voices, setVoices] = useState<VoiceSummary[]>([])
  const [voiceView, setVoiceView] = useState<string | null>(null) // a platform whose profile fills the page
  const [brainView, setBrainView] = useState(false) // the Brain fills the page
  const brainFolder = settings?.brainFolder ?? DEFAULT_BRAIN_FOLDER
  const refreshVoices = useCallback(() => api.voice().then(setVoices).catch(fail), [fail])
  // Ideas: the full-page list, the one-line capture box, and a counter that tells the list to re-read.
  const [ideasView, setIdeasView] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)
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
  const refreshTrash = useCallback(() => api.trash().then(setTrash).catch(fail), [fail])
  const [toast, setToast] = useState<{ text: string; undo?: () => void; label?: string } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  /** A short message at the bottom; `undo` adds a button, named `label` (Undo unless said otherwise). */
  const notify = useCallback((text: string, undo?: () => void, label?: string) => {
    window.clearTimeout(toastTimer.current)
    setToast({ text, undo, label })
    toastTimer.current = window.setTimeout(() => setToast(null), 6000)
  }, [])
  // The open document's Thinking Space, and which of its fragments the draft already uses.
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [thinking, setThinking] = useState<Thinking | null>(null)
  // Sparks fills the window; a piece started from it opens in its Thinking Space once it's loaded.
  const [sparksOpen, setSparksOpen] = useState(false)
  // Once opened, the page stays mounted (hidden when closed) so its cards survive a visit to a note.
  const [sparksMounted, setSparksMounted] = useState(false)
  useEffect(() => {
    if (sparksOpen) setSparksMounted(true)
  }, [sparksOpen])
  const thinkOnLoad = useRef<string | null>(null)
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
  // Read as…: its card in the Piece tab, and the latest list of reader questions (this session only).
  const [readerOpen, setReaderOpen] = useState(false)
  const [readerFocus, setReaderFocus] = useState(0)
  const [reading, setReading] = useState<Reading | null>(null)
  const recallDot = settings?.recallDot ?? true
  // Changes show at once; the server's cleaned copy replaces them only if no newer change was made
  // meanwhile (dragging the text size sends many), or an older reply would undo the newer change.
  const settingsSeq = useRef(0)
  const changeSettings = useCallback(
    (patch: Partial<SettingsT>) => {
      setSettings((s) => (s ? { ...s, ...patch } : s))
      const seq = ++settingsSeq.current
      api
        .saveSettings(patch)
        .then((next) => {
          if (seq === settingsSeq.current) setSettings(next)
          // Provider or model changes show up in the Piece module's Models list.
          if ('provider' in patch || 'wordLocal' in patch || 'embedder' in patch || /Model$/.test(Object.keys(patch)[0])) api.status().then(setStatus).catch(fail)
        })
        .catch((e) => {
          fail(e)
          // Refused (a Brain folder that holds the writer's pieces, say): show what is really saved, not the refused change.
          if (seq === settingsSeq.current)
            api
              .settings()
              .then(setSettings)
              .catch(() => {})
        })
    },
    [fail],
  )

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
    fileText.set(d ? joinDoc(d) : '')
  }, [fileText])
  const autosaveMs = useRef(APPEARANCE_DEFAULTS.autosaveMs)
  autosaveMs.current = settings?.autosaveMs ?? APPEARANCE_DEFAULTS.autosaveMs
  const renamed = useRef<string | null>(null)
  const opened = useRef(0)
  const textOf = (d: Doc) => joinDoc(d)
  const [store] = useState(browserStore)
  // Everything between a keystroke and the disk: autosave, retries, conflicts (see saver.ts).
  const [saver] = useState(
    () =>
      new Saver({
        write: (path, content, opts) => api.write(path, content, opts),
        // The page forgives `**bold **` while it's being typed; the file always gets valid Markdown.
        content: () => (docRef.current ? { path: docRef.current.path, content: textOf(docRef.current) } : null),
        onState: (state) => {
          setSaved((was) => {
            if (state === 'failed' || state === 'conflict' || state === 'gone') setSaveNews(state === 'failed' ? 'Not saved. Retrying.' : 'Not saved.')
            else if (state === 'saved' && (was === 'failed' || was === 'conflict' || was === 'gone')) setSaveNews('Saved.')
            return state
          })
          if (state === 'saved') {
            setVersionsTick((t) => t + 1) // a save can keep a version
            // Tags typed into the text show in the sidebar without re-reading the vault.
            const d = docRef.current
            if (d) {
              const tags = docTags(d)
              setFiles((fs) => (fs.some((f) => f.path === d.path && f.tags?.join('\n') !== tags.join('\n')) ? fs.map((f) => (f.path === d.path ? { ...f, tags } : f)) : fs))
            }
          }
        },
        onConflict: setConflict,
        onGone: () => setConflict(null),
        store,
        delay: () => autosaveMs.current,
      }),
  )
  // File operations (rename, move, star, …) run one at a time, each after the open document is saved.
  const [queue] = useState(createQueue)

  // The vault's documents. Until the first listing arrives, neither the welcome card nor a page shows.
  const [filesLoaded, setFilesLoaded] = useState(false)
  const [vaultError, setVaultError] = useState<string | null>(null)
  const refreshFiles = useCallback(
    () =>
      api
        .files()
        .then((list) => {
          setFiles(list)
          setFilesLoaded(true)
          setVaultError(null)
        })
        .catch((e) => (e instanceof ApiError && e.code === 'VAULT_UNAVAILABLE' ? setVaultError(e.message) : fail(e))),
    [fail],
  )
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
    api.status().then(setStatus).catch(fail)
    api.settings().then(setSettings).catch(fail)
    refreshVoices()
    refreshTrash()
  }, [refreshFiles, refreshVoices, refreshTrash, fail])

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

  // Once started (see "Where Ekdanta starts"), the open page stays a real one: when it goes (deleted, or an
  // import undone) the first page opens, never ideas.md, which is material rather than a page; with no
  // pages left the welcome card shows. A page that has gone is never read, which would be an error banner.
  // The open one stays even if its file has gone on disk, so the writer can put it back (see the deleted bar).
  useEffect(() => {
    if (!started || (path && (files.some((f) => f.path === path) || docRef.current?.path === path))) return
    setPath(pages.length ? pages[0].path : null)
  }, [started, files, pages, path, setPath])

  // The quick switcher's recent documents.
  useEffect(() => {
    if (path) setRecentDocs((r) => (r[0] === path ? r : pushRecent(r, path)))
  }, [path, setRecentDocs])

  useEffect(() => {
    if (!path || !started) return
    if (renamed.current === path) {
      renamed.current = null // same document under a new name: nothing to reload
      return
    }
    // Leaving a document stops its saves; text that never reached the disk stays in this browser, offered when it opens again.
    if (saver.base && saver.base.path !== path) saver.close()
    let cancelled = false
    let retry: number | undefined
    if (briefFor.current !== path) briefFor.current = null
    setBrief(null)
    setBriefEditing(false)
    // The page and its brief arrive together (a brief that can't be read stays null: nothing to edit or overwrite).
    const load = (attempt: number) =>
      Promise.all([api.readFile(path), api.brief(path).catch(() => null)])
        .then(([{ content, mtime }, b]) => {
          if (cancelled) return
          // Typed into the page being left while this one loaded: kept in this browser, offered when it opens again.
          if (!saver.base && saver.dirty) saver.close()
          const d = (docRef.current = { ...splitFrontMatter(content), path })
          const caret = pendingCaret.current?.path === path ? pendingCaret.current.caret : null
          pendingCaret.current = null
          syncText()
          // A fresh key for every opening: a new untitled.md can reuse the name of a draft just titled and renamed.
          setLoaded({ ...d, key: `${path}#${++opened.current}`, caret })
          setBodyEmpty(!d.body.trim())
          saver.open(path, mtime, content)
          setConflict(null)
          setOpenFailed(null)
          const draft = draftToOffer(store, path, content)
          setOffer(draft && { ...draft, path })
          if (b !== null) setBrief({ doc: d, text: b })
          // Opened from its ⋯ menu to pin a brief (asked for before or while it loaded).
          if (briefFor.current === path) {
            briefFor.current = null
            setBriefEditing(b !== null)
          }
        })
        .catch((e) => {
          if (cancelled) return
          if (e instanceof ApiError && e.status === 404) {
            setOpenFailed(null)
            return refreshFiles() // gone: the list moves on
          }
          // The server is away. The page being left mustn't stay on screen looking editable (nothing would
          // save it), so it goes, and this one is read again until the server answers.
          if (docRef.current && docRef.current.path !== path) {
            saver.close() // anything typed meanwhile stays in this browser
            docRef.current = null
            setLoaded(null)
          }
          setOpenFailed(path)
          retry = window.setTimeout(() => load(attempt + 1), retryDelay(attempt))
        })
    load(0)
    api
      .history(path)
      .then((h) => !cancelled && setHistory(h as HistoryItem[]))
      .catch(() => {}) // no history yet is fine
    setThinking(null)
    setMaterial({ covered: [], nearest: null })
    api
      .thinking(path)
      .then((t) => !cancelled && setThinking(t))
      .catch(() => {})
    return () => {
      cancelled = true
      window.clearTimeout(retry)
    }
  }, [path, started, saver, store, refreshFiles, syncText])

  // The open page's brief: only while it belongs to the page on screen (every switch re-renders).
  const openBrief = brief && brief.doc === docRef.current ? brief : null

  /** Save now (⌘S, or before something reads the saved file). Never throws: a failure shows on the chip. */
  const save = useCallback(() => saver.flush(), [saver])

  /**
   * Everything typed is on disk: a pending save runs now, one in flight is waited for. If the text can't
   * be saved (the server is down, or the file changed on disk), this refuses rather than let an export
   * quietly use the older version on disk.
   */
  const flush = useCallback(async () => {
    if (!(await saver.flush())) throw new Error('the latest changes aren’t saved yet, so an export would miss them')
  }, [saver])

  const onChange = useCallback(
    (text: string) => {
      if (docRef.current) docRef.current.body = text
      setBodyEmpty(!text.trim())
      syncText()
      saver.edited()
    },
    [saver, syncText],
  )

  // Leaving with unsaved text: the browser asks first, and the text is kept here in case they go anyway.
  useEffect(() => {
    // The dev server restarting reloads the page once it's back. That isn't the writer leaving: no
    // question, and the text goes to the server (up again by then) and stays in this browser.
    let serverRestart = false
    const hot = import.meta.hot
    const away = () => (serverRestart = true)
    const back = () => (serverRestart = false)
    hot?.on('vite:ws:disconnect', away)
    hot?.on('vite:ws:connect', back)
    const before = (e: BeforeUnloadEvent) => {
      if (!saver.busy) return
      saver.keepDraft()
      if (serverRestart) return
      e.preventDefault()
      e.returnValue = '' // older browsers need this to ask
    }
    const hide = () => {
      if (!saver.dirty) return
      saver.keepDraft()
      // One last try that outlives the page, also after failed saves; the base mtime keeps it from
      // overwriting anything newer. Not for a conflict or a deleted file: those wait for the writer.
      const d = docRef.current
      const live = saver.state === 'unsaved' || saver.state === 'saving' || saver.state === 'failed'
      const now = d && saver.base?.path === d.path && live ? { path: d.path, content: textOf(d), baseMtime: saver.base.mtime } : null
      if (now && now.content.length < 60_000) fetch('/api/file', { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(now) }).catch(() => {})
    }
    window.addEventListener('beforeunload', before)
    window.addEventListener('pagehide', hide)
    return () => {
      hot?.off?.('vite:ws:disconnect', away)
      hot?.off?.('vite:ws:connect', back)
      window.removeEventListener('beforeunload', before)
      window.removeEventListener('pagehide', hide)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saver])

  /** The open document as it is on screen, front matter included: what a version keeps. */
  const currentText = useCallback(() => {
    const d = docRef.current
    return d ? joinDoc(d) : ''
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
      await save()
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
    await save()
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
        // A save that fails here leaves the text in this browser, offered when the document opens again.
        const clean = await saver.flush()
        if (clean && !d.meta.title?.trim() && !d.body.trim()) {
          const discarded = await api
            .discard(d.path)
            .then((r) => r.discarded)
            .catch(() => false)
          if (discarded) await refreshFiles()
        }
      }
      setFresh((f) => (f === next ? f : null))
      setLayoutFor((f) => (f === next ? f : null))
      setVoiceView(null)
      setBrainView(false)
      setIdeasView(false)
      if (!newly) setLivePreview(chosenView)
      setPath(next)
    },
    [saver, refreshFiles, setPath, chosenView],
  )

  // ---- Taking in versions from disk ---------------------------------------------------------
  // Where the caret was when the page was re-read, so it lands back there.
  const caret = useRef<{ from: number; to: number; focused: boolean; scroll: number; at: number } | null>(null)

  /** Show a new version of the open document's text, keeping the caret where it was. */
  const showText = useCallback(
    (content: string) => {
      const d = docRef.current
      if (!d) return
      const fm = splitFrontMatter(content)
      const bodyChanged = fm.body !== d.body
      // The whole front matter is taken in (raw text, lists, read-only state), so it's written back as found.
      delete d.problem
      Object.assign(d, fm)
      syncText()
      setBodyEmpty(!fm.body.trim())
      if (!bodyChanged) return setLoaded((l) => (l ? { ...l, ...fm, problem: fm.problem } : l))
      const ed = editorRef.current
      caret.current = { from: ed?.state.selection.from ?? 0, to: ed?.state.selection.to ?? 0, focused: !!ed?.isFocused, scroll: document.querySelector('.page-area')?.scrollTop ?? 0, at: Date.now() }
      setLoaded({ ...d, key: `${d.path}#${++opened.current}`, caret: null }) // a new key: the page is read afresh
    },
    [syncText],
  )

  const onEditor = useCallback((ed: TiptapEditor | null) => {
    setEditor(ed)
    const c = caret.current
    if (!ed || !c || Date.now() - c.at > 2000) return
    caret.current = null
    try {
      const at = (n: number) => Math.max(1, Math.min(n, ed.state.doc.content.size - 1))
      ed.commands.setTextSelection({ from: at(c.from), to: at(c.to) })
    } catch {
      /* the text is shorter now */
    }
    if (c.focused) ed.commands.focus(null, { scrollIntoView: false })
    const area = document.querySelector('.page-area')
    if (area) area.scrollTop = c.scroll
  }, [])

  /**
   * A version of the open document is on disk that its text isn't based on. `ours`: Ekdanta wrote it
   * (a relink, a star, a template) and it merges into anything typed meanwhile. Otherwise someone else
   * did: it replaces untouched text, and asks the writer if they have unsaved changes.
   */
  const takeIn = useCallback(
    (disk: { content: string; mtime: number }, ours: boolean) => {
      const d = docRef.current
      const base = saver.base
      if (!d || !base) return
      const mine = textOf(d)
      if (disk.content === base.content || disk.content === mine) return saver.adopt(disk.mtime, disk.content, !saver.dirty || disk.content === mine)
      if (!saver.dirty) {
        showText(disk.content)
        saver.adopt(disk.mtime, disk.content, true)
        if (!ours) notify('Updated from disk')
        return
      }
      const merged = ours ? rebase(base.content, disk.content, mine) : null
      if (merged !== null) {
        showText(merged)
        saver.adopt(disk.mtime, disk.content, merged === disk.content)
        return
      }
      saver.clash({ path: d.path, ...disk })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saver, showText, notify],
  )

  /** After a file operation: if it rewrote the open document, take in the new version. */
  const absorb = async (touched: Touched[] | undefined) => {
    const d = docRef.current
    const t = touched?.find((x) => x.path === d?.path)
    if (!d || !t || !saver.base || t.mtime === saver.base.mtime) return
    // The list first: a page read afresh shows its [[links]] against the names they have now.
    await refreshFiles()
    const disk = await api.readFile(d.path).catch(() => null)
    if (disk && docRef.current === d && saver.base?.path === d.path && disk.mtime !== saver.base.mtime) takeIn(disk, true)
  }

  /** Run a file operation: after the open document is saved, with autosave held until it's done, one at a time. */
  const op = <T,>(job: () => Promise<T>) =>
    queue(async () => {
      await saver.flush()
      saver.pause()
      try {
        return await job()
      } finally {
        saver.resume()
      }
    })
  const failed = (what: string) => (e: unknown) => notify(`Couldn’t ${what}: ${e instanceof Error ? e.message : 'the app’s server didn’t answer'}`)

  /** A poll found changes on disk. Is the open document among them? */
  const checkOpen = async (c: Changes) => {
    const d = docRef.current
    const base = saver.base
    if (!d || !base || base.path !== d.path) return
    const mentioned = c.reset || c.deleted.includes(d.path) || [...c.changed, ...c.created].some((x) => x.path === d.path && x.mtime !== base.mtime)
    if (!mentioned) return
    await saver.settled() // our own save may be what changed it
    let disk: { content: string; mtime: number }
    try {
      disk = await api.readFile(d.path)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && docRef.current === d && saver.state !== 'gone') saver.gone()
      return
    }
    if (docRef.current !== d || saver.base?.path !== d.path || disk.mtime === saver.base.mtime) return
    if (saver.state === 'conflict') return setConflict({ path: d.path, ...disk }) // theirs moved on again
    takeIn(disk, false)
  }
  const checkOpenRef = useRef(checkOpen)
  checkOpenRef.current = checkOpen

  // Watch the vault for changes made elsewhere (Obsidian, a shell, another tab), while the page is in view.
  useEffect(() => {
    let since: number | undefined
    let timer: number | undefined
    let running = false
    let stopped = false
    const poll = async () => {
      window.clearTimeout(timer)
      if (running || stopped) return
      running = true
      try {
        if (document.visibilityState === 'visible') {
          const c = await api.changes(since)
          const first = since === undefined
          since = c.now
          if (!first && (c.reset || c.changed.length || c.created.length || c.deleted.length)) {
            refreshFiles()
            await queue(() => checkOpenRef.current(c))
          }
        }
      } catch {
        /* the server is away; try again next time */
      } finally {
        running = false
        if (!stopped) timer = window.setTimeout(poll, 5000)
      }
    }
    const onVisible = () => document.visibilityState === 'visible' && poll()
    poll()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [queue, refreshFiles])

  /**
   * Text that is about to leave the screen without reaching the disk, kept so it can come back: put back
   * on the page if its document is still the open one, else kept in this browser and offered when it opens.
   */
  const putBack = (d: Doc, text: string) => {
    if (docRef.current === d && saver.base?.path === d.path) {
      showText(text)
      saver.edited()
      return
    }
    writeDraft(store, d.path, { content: text, at: Date.now() })
    notify(`Kept in this browser: it’s offered when “${d.meta.title || d.path}” opens`)
  }

  const [compare, setCompare] = useState<'conflict' | 'draft' | null>(null)
  const loadTheirs = () => {
    const d = docRef.current
    if (!conflict || !d || conflict.path !== d.path) return setConflict(null)
    const mine = textOf(d)
    showText(conflict.content)
    saver.adopt(conflict.mtime, conflict.content, true)
    setConflict(null)
    setCompare(null)
    // Undo is for this document only: by then another may be open, and this text must never land there.
    notify('Loaded the version on disk', () => putBack(d, mine))
  }
  const keepMine = () => {
    if (conflict) saver.keepMine(conflict.mtime)
    setConflict(null)
    setCompare(null)
  }
  const restoreDraft = () => {
    const d = docRef.current
    if (!offer || !d || offer.path !== d.path) return setOffer(null)
    const now = textOf(d)
    const draft = offer
    showText(draft.content)
    saver.edited()
    setOffer(null)
    setCompare(null)
    // The text that was on the page (perhaps typed since it opened) can come back.
    notify('Restored the unsaved changes', () => putBack(d, now))
  }
  const discardDraft = () => {
    if (!offer) return
    const draft = offer
    dropDraft(store, draft.path)
    setOffer(null)
    setCompare(null)
    notify('Discarded the unsaved changes', () => {
      writeDraft(store, draft.path, { content: draft.content, at: draft.at })
      if (docRef.current?.path === draft.path) setOffer(draft)
    })
  }
  const recreate = () => {
    saver.recreate()
    saver.settled().then(refreshFiles)
  }
  /** The deleted file's notice, dismissed: the page closes; text not on disk stays in this browser, offered if the file comes back. */
  const closeGone = () => {
    saver.close()
    docRef.current = null
    setLoaded(null)
    setPath(pages.find((f) => f.path !== path)?.path ?? null)
    refreshFiles()
  }

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

  // Where Ekdanta starts. One decision, made once, when both the settings and the vault's first listing
  // have arrived (a vault that can't be used never lists: its card shows and nothing is opened or made):
  //  1. A remembered page that has gone (deleted, or an import undone) is forgotten rather than read,
  //     which would be an error banner over the welcome card.
  //  2. An empty vault (no pages; ideas.md is material, not a page) shows the welcome card: no draft is made.
  //  3. Open last on: the remembered page, or else the first page. Never ideas.md by itself: the Ideas row opens it.
  //  4. Open last off: a fresh draft, using again an empty untitled draft left from last time rather than
  //     piling up untitled files. If the draft can't be made, the page from 3 opens under the error.
  const starting = useRef(false)
  useEffect(() => {
    if (!settings || !filesLoaded || starting.current) return
    starting.current = true
    const last = remembered.current && files.some((f) => f.path === remembered.current) ? remembered.current : null
    const fallback = last ?? pages[0]?.path ?? null
    if (!pages.length || settings.openLast) {
      setPath(pages.length ? fallback : null)
      setStarted(true)
      return
    }
    ;(async () => {
      try {
        if (last && /(^|\/)untitled(-\d+)?\.md$/.test(last)) {
          const { meta, body } = splitFrontMatter(await api.read(last).catch(() => ''))
          if (!meta.title?.trim() && !body.trim()) {
            setFresh(last)
            setLivePreview(settings.newDocView !== 'markdown')
            setPath(last)
            return
          }
        }
        await newDraft()
      } catch (e) {
        fail(e)
        setPath(fallback)
      } finally {
        setStarted(true)
      }
    })()
  }, [settings, filesLoaded, files, pages, newDraft, setPath, fail])

  /** From the welcome card: a first draft of the chosen kind, in that kind's folder. */
  const startWriting = async (kind: string) => {
    const k = kinds().find((x) => x.id === kind)
    try {
      const { path: rel } = await api.create(k?.folder ?? '', kind)
      await refreshFiles()
      setFresh(rel)
      await openDoc(rel)
    } catch (e) {
      fail(e)
    }
  }

  // Import: the sheet, opened with the file chooser, with dropped files, or (from the palette) either.
  const [importing, setImporting] = useState<{ files?: File[]; pick: boolean } | null>(null)
  const [importProgress, setImportProgress] = useState<string | null>(null)
  const startImport = useCallback((files?: File[]) => setImporting((open) => open ?? { files, pick: !files }), [])
  /** Notes the import just took back out: the open one can't stay open (a save would bring it back). */
  const importUndone = async (paths: string[]) => {
    if (docRef.current && paths.includes(docRef.current.path)) {
      saver.close()
      docRef.current = null
      setLoaded(null)
    }
    await refreshFiles()
    refreshTrash()
  }
  const importDone = async (paths: string[]) => {
    await refreshFiles()
    // A vault that was empty opens the first note straight away.
    if (!docRef.current && paths[0]) openDoc(paths[0])
  }
  const importClosed = (batch: string | null, paths: string[]) => {
    setImporting(null)
    if (!batch || !paths.length) return
    notify(`Imported ${paths.length} ${paths.length === 1 ? 'note' : 'notes'}`, () =>
      api
        .importUndo(batch)
        .then(({ removed }) => importUndone(removed))
        .catch(fail),
    )
  }

  const setMeta = (patch: MetaPatch) => {
    const d = docRef.current
    if (!d) return
    // A block Ekdanta can't rewrite stays as it is: say so rather than drop the change.
    if (d.readonly) return notify(READONLY_META)
    Object.assign(d, patchFrontMatter(d, patch))
    syncText()
    setLoaded((l) => (l ? { ...l, meta: d.meta, lists: d.lists } : l))
    saver.edited()
    saver.flush().then(refreshFiles)
  }

  /** Change front matter of a given file: the open one through the editor's copy, any other on disk. */
  const setMetaOf = async (rel: string, patch: MetaPatch) => {
    if (docRef.current?.path === rel) {
      // Read-only front matter isn't changed: the listing is read again, so a star shown ahead of it goes back.
      if (docRef.current.readonly) refreshFiles()
      setMeta(patch)
    } else
      await op(async () => {
        await absorb((await api.patchMeta(rel, patch)).touched)
        await refreshFiles()
      }).catch((e) => {
        failed('change it')(e)
        // The listing is read again, so a star shown ahead of the save goes back to what the file says.
        refreshFiles()
      })
  }

  /** A title written for the first time also names the file, and fills a template's {{title}} if it's still there. */
  const setTitle = async (title: string) => {
    const d = docRef.current
    if (!d) return
    if (d.readonly) return notify(READONLY_META) // the title field is read-only too; this is the backstop
    if (!d.meta.title?.trim() && title.trim() && d.body.includes('{{title}}')) {
      if (editor && livePreview)
        replacePlaceholder(editor, '{{title}}', title) // the page reports the change, which updates d.body
      else {
        d.body = d.body.split('{{title}}').join(title)
        setLoaded((l) => (l ? { ...l, body: d.body, key: l.key + '~' } : l))
      }
    }
    Object.assign(d, patchFrontMatter(d, { title }))
    syncText()
    setLoaded((l) => (l ? { ...l, meta: d.meta, lists: d.lists } : l))
    saver.edited()
    await op(async () => {
      if (docRef.current !== d) return
      const { path: next, touched } = await api.name(d.path, title)
      follow(next)
      await absorb(touched)
      refreshFiles()
    }).catch(failed('name the file'))
  }

  /** A new platform moves the piece into that platform's folder. */
  const setPlatform = async (platform: string) => {
    const d = docRef.current
    if (!d) return
    if (d.readonly) return notify(READONLY_META)
    const patch: MetaPatch = { platform }
    // A new, empty piece takes its new kind's document defaults (and gives back the old kind's).
    if (fresh === d.path && !d.body.trim()) Object.assign(patch, kindSwitchPatch(d.meta, findKind(kinds(), d.meta.platform ?? '')?.doc, findKind(kinds(), platform)?.doc))
    Object.assign(d, patchFrontMatter(d, patch))
    syncText()
    setLoaded((l) => (l ? { ...l, meta: d.meta, lists: d.lists } : l))
    saver.edited()
    await op(async () => {
      if (docRef.current !== d) return
      const { path: next, touched } = await api.place(d.path)
      follow(next)
      await absorb(touched)
      refreshFiles()
      refreshVoices()
    }).catch(failed('move it to its folder'))
  }

  /** Read the open document again after the server rewrote it, with the caret at `caret` (an offset into the body). */
  const reloadOpen = async (caret: number | null) => {
    const d = docRef.current
    if (!d) return
    const { content, mtime } = await api.readFile(d.path)
    if (docRef.current !== d) return
    const next = (docRef.current = { ...splitFrontMatter(content), path: d.path })
    syncText()
    setLoaded({ ...next, key: `${d.path}#${++opened.current}`, caret })
    setBodyEmpty(!next.body.trim())
    saver.open(d.path, mtime, content)
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
    await save()
    const doc = docRef.current
    if (!doc) return
    const ed = editorRef.current
    if (!livePreview || !ed) {
      // The server fills the file, with autosave held so nothing typed meanwhile is written over it.
      await op(async () => {
        if (docRef.current !== doc) return
        const { cursor } = await api.applyTemplate(doc.path, t.path)
        await reloadOpen(cursor)
        refreshFiles()
      }).catch(templateFailed)
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

  /** Everything a page's ⋯ menu does. Each waits its turn, after the open page is saved, so nothing typed is lost. */
  const fileActions: FileActions = {
    rename: (rel, title) =>
      op(async () => {
        const { path: next, touched } = await api.rename(rel, title)
        if (docRef.current?.path === rel) follow(next)
        await absorb(touched)
        refreshFiles()
        refreshVoices()
      }).catch(failed('rename')),
    move: (rel, folder) =>
      op(async () => {
        const { path: next, touched } = await api.move(rel, folder)
        if (docRef.current?.path === rel) follow(next)
        await absorb(touched)
        await refreshFiles()
        refreshVoices()
        notify(`Moved to ${folder.split('/').pop()}`, () => fileActions.move(next, rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''))
      }).catch(failed('move')),
    layout: async (rel) => {
      if (docRef.current?.path !== rel) await openDoc(rel)
      setLayoutFor(rel)
    },
    duplicate: async (rel) => {
      const next = await op(async () => (await api.duplicate(rel)).path).catch(failed('duplicate'))
      if (!next) return
      await refreshFiles()
      await openDoc(next)
    },
    remove: (rel) =>
      op(async () => {
        const isOpen = docRef.current?.path === rel
        const item = await api.remove(rel)
        if (isOpen) {
          // Text that never reached the disk stays in this browser under its path: Undo (or a restore from
          // the trash) brings the file back to the same place, and the text is offered again there.
          saver.close()
          docRef.current = null // nothing left to save to
        }
        const left = (await api.files()).filter((f) => f.path !== rel)
        setFiles(left)
        if (isOpen) {
          setLoaded(null)
          // The next page, not ideas.md; with no pages left the welcome card takes over.
          const next = left.find((f) => !isSpecialFile(f.path))
          if (next) openDoc(next.path)
        }
        refreshTrash()
        refreshVoices()
        notify(`Deleted “${item.title}”`, () => restore(item.id))
      }).catch(failed('delete')),
    export: (rel) => setExporting(rel),
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
    const back = await op(async () => (await api.restore(id)).path).catch(failed('restore'))
    if (!back) return
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
    saver.retarget(next) // its unsaved draft, if any, goes with it
    renamed.current = next
    // Rename it in the list now too, or the app would think the open file had gone.
    setFiles((fs) => fs.map((f) => (f.path === prev ? { ...f, path: next, folder: next.includes('/') ? next.slice(0, next.lastIndexOf('/')) : '' } : f)))
    setLoaded((l) => (l ? { ...l, path: next } : l))
    setFresh((f) => (f === prev ? next : f))
    setLayoutFor((f) => (f === prev ? next : f))
    setRecentDocs((r) => r.map((p) => (p === prev ? next : p)))
    setPath(next)
  }

  /** Settings → Kinds: move a kind's pieces out of a doubled-plural folder, following the open document if it moves. */
  const renameKindFolder = (id: string) =>
    op(async () => {
      const { settings: next, moved, touched } = await api.renameKindFolder(id)
      setSettings(next)
      const mine = moved.find((m) => m.from === docRef.current?.path)
      if (mine) follow(mine.to)
      await absorb(touched)
      await refreshFiles()
    })

  /** ★ a document as an exemplar of its platform, or un-star it. */
  const toggleExemplar = async (rel: string) => {
    const f = files.find((x) => x.path === rel)
    if (!f) return
    // Notes on books and talks hold other people's words: never the writer's voice.
    if (!f.exemplar && isBrainPath(rel, brainFolder)) return notify('Notes in the Brain can’t be exemplars')
    const patch = { exemplar: f.exemplar ? null : 'true' }
    setFiles((fs) => fs.map((x) => (x.path === rel ? { ...x, exemplar: !x.exemplar } : x)))
    // The open document saves through the editor, so its front-matter must change there too.
    await setMetaOf(rel, patch)
    refreshVoices() // the profile for this platform is now out of date
  }

  const openVoice = (platform: string) => {
    refreshVoices()
    setBrainView(false)
    setIdeasView(false)
    setVoiceView(platform)
  }

  const openIdeas = () => {
    setVoiceView(null)
    setBrainView(false)
    setIdeasView(true)
  }

  /** Add an idea to ideas.md. If ideas.md is the open page, it's saved first and re-read after, so neither edit is lost. */
  const captureIdea = async (text: string) => {
    // With ideas.md open, it's saved first and autosave held, and the new line merges into anything typed since.
    const added = await op(async () => {
      const r = await api.captureIdea(text)
      await absorb(r.touched)
      return r.added
    }).catch((e) => {
      notify(`Couldn’t save the idea: ${e instanceof Error ? e.message : 'the app’s server didn’t answer'}`)
      return null
    })
    if (added === null) return
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

  // ---- Navigate: palette, switcher, search ----------------------------------------------------

  // A sheet or space that owns the keyboard while it's up. The palette, quick open and search wait
  // until it's closed: over it, Esc and the caret would land in the page hidden behind it.
  const layer = settingsOpen ? 'Settings' : thinkingOpen ? 'the Thinking Space' : picker ? 'the template picker' : importing ? 'the Import sheet' : captureOpen ? 'the idea box' : null
  const layerNow = useRef(layer)
  layerNow.current = layer
  const overlayNow = useRef(overlay)
  overlayNow.current = overlay
  /** Where focus was when the palette or quick open came up: it goes back there when they close. */
  const overlayFrom = useRef<Element | null>(null)

  /** Back to the writing: the page (with its selection as it was), or the Markdown view. */
  const focusEditor = useCallback(() => {
    // The view's own focus is immediate (Tiptap's focus command waits a frame).
    if (editor && livePreview && !editor.isDestroyed) editor.view.focus()
    else focusText()
  }, [editor, livePreview])
  // At once, not on a later frame: a key pressed straight after (⌘O again) must not lose its focus to this.
  const restoreFocus = useCallback(() => {
    const back = overlayFrom.current
    overlayFrom.current = null
    const inPage = back && editor && !editor.isDestroyed && editor.view.dom.contains(back)
    if (back instanceof HTMLElement && back.isConnected && back !== document.body && !inPage) back.focus({ preventScroll: true })
    else if (!layerNow.current) focusEditor()
  }, [editor, focusEditor])
  const closeOverlay = useCallback(() => {
    setOverlay(null)
    restoreFocus()
  }, [restoreFocus])

  /** Open the palette or the switcher, or close it if it's the one showing. Not over a help card or a sheet. */
  const toggleOverlay = useCallback(
    (which: 'palette' | 'switcher') => {
      const o = overlayNow.current
      if (o === which) return closeOverlay()
      if (o) return setOverlay(which)
      if (layerNow.current) return notify(`Close ${layerNow.current} first`)
      if (document.querySelector(HELP_OPEN)) return
      overlayFrom.current = document.activeElement
      setOverlay(which)
    },
    [closeOverlay, notify],
  )
  // A sheet opened while the palette was up (its shortcut, typed there) takes over: the palette goes.
  useEffect(() => {
    if (!layer) return
    overlayFrom.current = null
    setOverlay(null)
  }, [layer])

  /** ⌘⇧F: the search pane, with the caret in its box (pressed again, it selects what's there). */
  const openSearch = useCallback(() => {
    if (layerNow.current) return notify(`Close ${layerNow.current} first`)
    setSidebarMode('search')
    setSidebarOpen(true)
    setSearchFocus((n) => n + 1)
  }, [setSidebarMode, setSidebarOpen, notify])

  /** Ask which fragments the draft covers, and which is nearest the paragraph being written. */
  const checkMaterial = useCallback(
    (delay = 700) => {
      window.clearTimeout(materialTimer.current)
      const d = docRef.current
      const frags = (thinking?.canvas.nodes ?? []).filter((n) => n.type === 'text' && n.text?.trim()).map((n) => ({ id: n.id, text: n.text! }))
      if (!d || !frags.length) return
      materialTimer.current = window.setTimeout(async () => {
        await save() // coverage reads the saved draft
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
    api
      .thinking(d.path)
      .then((t) => {
        setThinking(t)
        if (t.canvas.nodes.length) {
          setPanelOpen(true)
          setPanelTab('material')
        }
      })
      .catch(fail)
  }, [setPanelOpen, setPanelTab])

  const record = useCallback((item: HistoryItem) => {
    const d = docRef.current
    if (!d) return
    setHistory((h) => [...h, item])
    api.appendHistory(d.path, item)
  }, [])

  // The app commands below, for the palette and the More menu to run.
  const actionsRef = useRef<Partial<Record<CommandId, () => void>>>({})
  // Window-level shortcuts. Each app command is one line here; the first whose key matches runs.
  useEffect(() => {
    const openTab = (tab: 'material' | 'outline' | 'history' | 'piece') => {
      setPanelOpen(true)
      setPanelTab(tab)
    }
    const appActions: Partial<Record<CommandId, () => void>> = {
      focus: () => setFocus((f) => !f),
      panel: () => setPanelOpen((o) => !o),
      save: () => void save(),
      star: () => void (docRef.current && toggleExemplar(docRef.current.path)),
      settings: () => setSettingsOpen((o) => !o),
      export: () => docRef.current && setExporting(docRef.current.path),
      newDraft: () => newDraft(),
      newFromTemplate: () => setPicker('new'),
      import: () => startImport(),
      // The Thinking Space closes itself with the same key.
      thinking: () => {
        if (docRef.current && !thinkingOpen) {
          save()
          setThinkingOpen(true)
        }
      },
      material: () => openTab('material'),
      outline: () => openTab('outline'),
      history: () => openTab('history'),
      piece: () => openTab('piece'),
      documentLayout: () => {
        const d = docRef.current
        if (d) setLayoutFor((f) => (f === d.path ? null : d.path))
      },
      sparks: () => setSparksOpen(true),
      palette: () => toggleOverlay('palette'),
      switcher: () => toggleOverlay('switcher'),
      search: () => openSearch(),
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
      readAs: () => {
        if (!docRef.current) return
        // The card is hidden below help level 2, so say why rather than doing nothing at all.
        if (ceiling < 2) return notify('Read as… needs the help ceiling at 2 or more. Settings → Writing.')
        openTab('piece')
        setReaderOpen(true)
        setReaderFocus((n) => n + 1)
      },
      brain: () => void toggleBrain(),
    }
    actionsRef.current = appActions
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
  }, [focus, save, newDraft, setPanelOpen, setPanelTab, setHistorySeg, files, thinkingOpen, ceiling, livePreview, notify, startImport, toggleOverlay, openSearch, brainView])

  /** The Brain fills the page; again, and it's back to the writing. */
  const toggleBrain = async () => {
    if (brainView) return setBrainView(false)
    // Saved before the Brain can write to the same note, so the two never cross.
    await save()
    setVoiceView(null)
    setIdeasView(false)
    setThinkingOpen(false)
    setBrainView(true)
  }

  /**
   * The Brain wrote these notes. One open in the editor is read again: otherwise the editor would
   * still hold the old text, and its next save would put it back over the new highlights.
   */
  const brainChanged = (touched: Touched[]) => {
    refreshFiles()
    // Taken in as Ekdanta's own change: anything not yet saved merges with it rather than being written over.
    op(() => absorb(touched)).catch(fail)
  }

  const current = files.find((f) => f.path === path)
  // A note in the Brain is a source (a book, a talk), not a piece of the writer's own: it's labelled as one.
  const sourceLabel = loaded && isBrainPath(loaded.path, brainFolder) ? TYPE_LABELS[typeOf(loaded.meta, loaded.path)] : null
  const platform = (loaded?.meta.platform ?? current?.platform ?? 'essay').toLowerCase()
  const title = loaded ? (loaded.meta.title ?? current?.title ?? '') : ''
  const isNew = !!loaded && fresh === loaded.path
  // The one-time tip about help at the caret, until the writer dismisses it. It waits for a new draft
  // to have a first sentence or so: before that, ⌘3–⌘5 only ask opening questions, and the tip would
  // promise text they won't write. Not in the Markdown view, where help doesn't run.
  const [caretTipSeen, setCaretTipSeen] = usePref('tip.helpAtCaret', false)
  const showCaretTip = !caretTipSeen && !!loaded && !voiceView && livePreview && isNew && words >= 4
  // Document mode: page view, style and length target, all from the piece's own front matter.
  const docSet = docOf(loaded?.meta ?? {})
  const docKind = findKind(kinds(), platform)
  const sheet = !!loaded && !voiceView && !ideasView && !brainView && livePreview && docSet.page
  const layoutOpen = !!loaded && layoutFor === loaded.path
  const showDocButton = !!loaded && (usesDocument(loaded.meta, docKind) || layoutOpen)
  // A piece being written to a brief doesn't count its Works Cited or References: not in the total, the
  // selection, or the panel. LimitStatus counts the file's text by the same rule.
  const skipReferences = !!loaded && (usesDocument(loaded.meta, docKind) || !!loaded.meta.target?.trim())
  const counted = skipReferences ? countable(blocks) : { words, excluded: [] }
  const selectedCounted = (format?.selectedWords ?? 0) - (skipReferences ? (format?.selectedReferenceWords ?? 0) : 0)
  const due = dueLabel(loaded?.meta.due)
  const profile = useMemo(() => ({ name: settings?.profileName ?? '', institution: settings?.profileInstitution ?? '' }), [settings?.profileName, settings?.profileInstitution])
  const vaultTags = useMemo(() => vaultTagCounts(files), [files])
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
      return createPage(target.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, openDoc, refreshFiles],
  )

  const startedFromSpark = async (next: string) => {
    setSparksOpen(false)
    await refreshFiles()
    thinkOnLoad.current = next
    await openDoc(next)
  }
  useEffect(() => {
    if (loaded && thinkOnLoad.current === loaded.path) {
      thinkOnLoad.current = null
      setThinkingOpen(true)
    }
  }, [loaded])

  /** A new page with this title, next to the open one, and open it (a [[link]] to nowhere, or the switcher's Create). */
  const createPage = async (title: string) => {
    const folder = files.find((f) => f.path === docRef.current?.path)?.folder ?? ''
    const named = await op(async () => {
      const { path: created } = await api.create(folder)
      await api.patchMeta(created, { title })
      // Keep the name the link uses, so the link finds it.
      const { path: named, touched } = await api.rename(created, title)
      await absorb(touched)
      return named
    }).catch(failed('make the page'))
    if (!named) return
    await refreshFiles()
    await openDoc(named)
  }

  // ---- Navigate: running a command from the palette, and revealing a search match ---------------

  /** Why a command can't run right now, for the palette to grey it with. */
  const whyNot = (id: string): string | undefined => {
    const group = COMMANDS.find((c) => c.id === id)?.group
    const onPage = group === 'Text' || group === 'Blocks' || id === 'find' || id === 'readAloud'
    const needsDoc = onPage || ['save', 'star', 'thinking', 'brief', 'saveVersion', 'readAs'].includes(id)
    if (needsDoc && (!loaded || voiceView || ideasView || brainView)) return 'No document open'
    if (onPage && !livePreview) return 'Not in Markdown view'
    if (id === 'readAs' && ceiling < 2) return 'Needs help ceiling 2 or more'
    if (onPage && thinkingOpen) return 'Thinking Space is open'
    if (onPage && !editor) return 'No document open'
  }
  const runFromPalette = (id: string) => {
    setOverlay(null)
    restoreFocus()
    setRecentCommands((r) => pushRecent(r, id, 8))
    const group = COMMANDS.find((c) => c.id === id)?.group
    // After the palette has gone, so the command acts on the page (and its selection) as it was.
    requestAnimationFrame(() => {
      if ((group === 'Text' || group === 'Blocks' || id === 'find') && editor) runCommand(editor, id)
      else actionsRef.current[id as CommandId]?.()
    })
  }

  // A search result: open its document and select the match there, through the page's own find.
  const reveal = useRef<{ path: string; text: string; nth: number } | null>(null)
  const tryReveal = useCallback(() => {
    const r = reveal.current
    if (!r || !livePreview) return void (reveal.current = null)
    // The editor of the document being revealed, not the one it replaced.
    if (!editor || editor.isDestroyed || !editor.view.dom.isConnected || docRef.current?.path !== r.path) return
    reveal.current = null
    const view = editor.view
    setSearch(view, { query: r.text, matchCase: true, current: 0 })
    const n = searchState(view.state).matches.length
    if (n) setSearch(view, { current: Math.min(r.nth, n - 1) })
    // Leave the selection, not find's highlights.
    view.dispatch(view.state.tr.setMeta(searchKey, { query: '' }))
    view.focus()
  }, [editor, livePreview])
  useEffect(() => {
    tryReveal()
  }, [tryReveal, loaded?.key])
  const openAt = (target: string, select?: { text: string; nth: number }) => {
    reveal.current = select ? { path: target, ...select } : null
    if (docRef.current?.path === target && loaded?.key === target && !voiceView && !ideasView && !brainView) tryReveal()
    else openDoc(target)
  }

  const moreItems = [
    { id: 'palette', label: 'All commands', run: () => toggleOverlay('palette') },
    { id: 'switcher', label: 'Quick open', run: () => toggleOverlay('switcher') },
    { id: 'search', label: 'Search', run: openSearch },
    { id: 'sparks', label: 'Sparks', run: () => setSparksOpen(true) },
  ]

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
      body: JSON.stringify({ doc: d.path, reason, content: joinDoc(d) }),
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
      title: () => docRef.current?.meta.title ?? '',
      provider: () => statusRef.current?.strong ?? null,
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
    <div
      className={`app${focus ? ' is-focus' : ''}${panelOpen ? ' has-panel' : ''}${sidebarOpen ? ' has-sidebar' : ''}${settings?.paragraphFocus === false ? ' no-para-focus' : ''}${sheet ? ' has-sheet' : ''}`}
    >
      <header className="titlebar">
        <div className="crumb">
          {brainView ? (
            <b>Brain</b>
          ) : (
            <>
              {current?.folder ? <span className="muted">{current.folder} / </span> : null}
              {(loaded || !filesLoaded || pages.length > 0) && <b>{title || 'Untitled'}</b>}
            </>
          )}
        </div>
        <div className="titlebar-meta">
          {loaded && <SaveChip state={saved} onRetry={() => saver.retry()} />}
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
        <button className={`rail-btn${brainView ? ' is-on' : ''}`} title={titled('Brain', 'brain')} aria-pressed={brainView} onClick={() => void toggleBrain()}>
          <Icon name="book" />
        </button>
        <MoreMenu items={moreItems} />
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
          current={voiceView || ideasView || brainView ? null : path}
          ideasOpen={ideasView && !voiceView}
          ideaCount={ideaCount}
          onIdeas={openIdeas}
          onCaptureIdea={() => setCaptureOpen(true)}
          onOpen={openDoc}
          onCreate={newDraft}
          onStar={toggleExemplar}
          canStar={(p) => !isBrainPath(p, brainFolder)}
          brainFolder={brainFolder}
          actions={fileActions}
          trash={trash}
          onRestore={restore}
          search={{
            state: search,
            onState: (patch) => setSearchState((s) => ({ ...s, ...patch })),
            focusTick: searchFocus,
            current: voiceView || ideasView || brainView ? null : path,
            onReveal: openAt,
            onClose: () => setSidebarMode('vault'),
          }}
          tags={vaultTags}
          onImport={startImport}
        />
      )}

      <main className="page-area">
        {error && (
          <div className="app-error" role="alert">
            <span>{error}</span>
            <button className="icon-btn small" aria-label="Dismiss" title="Dismiss" onClick={() => setError(null)}>
              ✕
            </button>
          </div>
        )}
        {vaultError ? (
          <VaultError vault={status?.vault ?? ''} reason={vaultError} onRetry={refreshFiles} />
        ) : (
          filesLoaded &&
          !pages.length &&
          !loaded &&
          !voiceView &&
          !brainView && (
            <Welcome
              vault={status?.vault ?? ''}
              onStart={startWriting}
              onImport={() => startImport()}
              onSample={async () => {
                await api.useSample()
                await refreshFiles()
                refreshVoices()
              }}
            />
          )
        )}
        {voiceView && <VoicePage platform={voiceView} summary={voices.find((v) => v.platform === voiceView)} onOpenDoc={openDoc} onChanged={refreshVoices} />}
        {brainView && !voiceView && <BrainPage folder={brainFolder} onOpenDoc={openDoc} run={op} onChanged={brainChanged} />}
        {ideasView && !voiceView && <IdeasPage version={ideasVersion} onCapture={captureIdea} onStart={startIdea} onOpenDoc={openDoc} />}
        {loaded && !voiceView && !ideasView && !brainView && !focus && <Toolbar editor={editor} format={format} livePreview={livePreview} onLivePreview={chooseView} />}
        {/* Saving needs the writer. In focus mode the title bar is hidden, so a failing save shows here too. */}
        {loaded && !voiceView && !ideasView && !brainView && focus && saved === 'failed' && <SaveChip state={saved} onRetry={() => saver.retry()} floating />}
        {!loaded && openFailed && !voiceView && !ideasView && !brainView && <NoticeBar text="Couldn’t open the page: the app’s server isn’t answering. Trying again…" actions={[]} />}
        {loaded && !voiceView && !ideasView && !brainView && conflict && conflict.path === loaded.path && (
          <ConflictBar onTheirs={loadTheirs} onMine={keepMine} onCompare={() => setCompare('conflict')} />
        )}
        {loaded && !voiceView && !ideasView && !brainView && saved === 'gone' && (
          <NoticeBar
            text="This file was deleted on disk"
            actions={[
              { label: 'Recreate', title: 'Write it back with the text on screen', run: recreate },
              { label: 'Close', title: 'Close it (text that wasn’t saved stays in this browser)', run: closeGone },
            ]}
          />
        )}
        {loaded && !voiceView && !ideasView && !brainView && offer && offer.path === loaded.path && !conflict && (
          <NoticeBar
            text={`Unsaved changes from ${whenKept(offer.at)}`}
            actions={[
              { label: 'Compare', title: 'See them beside the page, word by word', run: () => setCompare('draft') },
              { label: 'Restore', title: 'Put back the text that wasn’t saved (Undo brings this text back)', run: restoreDraft },
              { label: 'Discard', title: 'Keep the page as it is', run: discardDraft },
            ]}
          />
        )}
        {loaded && !voiceView && !ideasView && !brainView && (
          <div className={`page${sheet ? ' is-sheet' : ''}`}>
            <div className="doc-meta">
              {sourceLabel ? (
                <>
                  <button className="link source-kind" title="Back to the Brain" onClick={() => void toggleBrain()}>
                    {sourceLabel} · Brain
                  </button>
                  {asStatus(loaded.meta.status) && <span className="muted">· {STATUS_LABELS[asStatus(loaded.meta.status) as keyof typeof STATUS_LABELS]}</span>}
                </>
              ) : (
                <>
                  <label className="platform">
                    <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Kind of writing" disabled={loaded.readonly}>
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
                </>
              )}
              {due && <span className={`doc-due${/^(Overdue|Due yesterday)/.test(due) ? ' is-late' : ' is-soon'}`}>· {due}</span>}
              {showDocButton && (
                <button
                  className="doc-btn"
                  aria-haspopup="dialog"
                  aria-expanded={layoutOpen}
                  title={titled('Document layout', 'documentLayout')}
                  onClick={() => setLayoutFor(layoutOpen ? null : loaded.path)}
                >
                  Document
                </button>
              )}
              {layoutOpen && (
                <DocumentPanel
                  meta={loaded.meta}
                  profile={profile}
                  defaultStyle={settings?.defaultStyle ?? 'mla'}
                  setMeta={(patch) => setMetaOf(loaded.path, patch)}
                  onClose={() => setLayoutFor(null)}
                />
              )}
              <span className="muted path">{loaded.path}</span>
            </div>
            <DocumentMode
              on={sheet}
              meta={loaded.meta}
              title={title}
              profile={profile}
              onPages={setSheetPages}
              onSheetClick={() => editor?.commands.focus('end')}
              onEdit={() => setLayoutFor(loaded.path)}
            >
              <TitleField
                readOnly={loaded.readonly}
                key={'title:' + loaded.key}
                spellcheck={spellcheck}
                value={loaded.meta.title ?? (current?.title === 'Untitled' ? '' : title)}
                autoFocus={isNew && loaded.caret == null}
                onCommit={setTitle}
                onHelp={(level) => window.dispatchEvent(new CustomEvent('ekdanta:help', { detail: { level } }))}
              />
              <Properties key={'props:' + loaded.key} fm={loaded} open={propsOpen} onOpen={setPropsOpen} onPatch={setMeta} vaultTags={vaultTags} />
              {isNew && !words && !sourceLabel && <PlatformPicker value={platform} onPick={setPlatform} />}
              {isNew && bodyEmpty && templates.length > 0 && (
                <StartFrom templates={templates} platform={platform} preferred={findKind(kinds(), platform)?.template} onApply={startFrom} onAll={() => setPicker('draft')} />
              )}
              {livePreview ? (
                <Editor
                  // Back from the Markdown view, the page is read afresh from what was written there.
                  key={loaded.key}
                  docKey={loaded.key}
                  // Opened to pin a brief: the paste box keeps the focus.
                  autoFocus={!isNew && !briefEditing && !(caret.current && Date.now() - caret.current.at < 2000)}
                  caret={loaded.caret}
                  templates={templateItems}
                  initial={docRef.current?.body ?? loaded.body}
                  onChange={onChange}
                  {...editorProps}
                  record={record}
                  snapshot={snapshotNow}
                  openDoc={openDoc}
                  onWordCount={setWords}
                  onBlocks={setBlocks}
                  onParagraph={onParagraph}
                  pages={() => pagesRef.current}
                  openPage={openPage}
                  saveImage={saveImage}
                  assetUrl={assetUrl}
                  onEditor={onEditor}
                  onFormat={setFormat}
                  onOutline={setOutline}
                  spellcheck={spellcheck}
                  lang={() => docRef.current?.meta.lang}
                  onReadUnavailable={() => notify('This browser has no voices to read aloud with. Settings → Writing explains.')}
                  edgeCurrent={edgeCurrent}
                  acceptEdge={acceptEdge}
                />
              ) : (
                <SourceEditor key={loaded.key + ':md'} initial={docRef.current?.body ?? loaded.body} onChange={onChange} onPageView={() => chooseView(true)} spellcheck={spellcheck} />
              )}
            </DocumentMode>
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
          words={counted.words}
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
          canStar={!!current && (!!current.exemplar || !isBrainPath(current.path, brainFolder))}
          source={sourceLabel ?? undefined}
          voice={voices.find((v) => v.platform === platform)}
          onVoice={() => openVoice(platform)}
          outline={outline}
          onHeading={goToHeading}
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
          editor={livePreview ? editor : null}
          readerOpen={readerOpen}
          onReaderOpen={setReaderOpen}
          readerFocus={readerFocus}
          reading={reading}
          onReading={setReading}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              onClick={() => {
                // Closed first, so an Undo that has something to say can say it in a new toast.
                setToast(null)
                toast.undo!()
              }}
            >
              {toast.label ?? 'Undo'}
            </button>
          )}
        </div>
      )}
      {compare === 'conflict' && conflict && docRef.current && (
        <CompareModal theirs={conflict.content} mine={textOf(docRef.current)} onClose={() => setCompare(null)} onTheirs={loadTheirs} onMine={keepMine} />
      )}
      {compare === 'draft' && offer && docRef.current && (
        <CompareModal
          theirs={textOf(docRef.current)}
          mine={offer.content}
          labels={{ theirs: 'Only on the page', mine: 'Only in the unsaved changes', useTheirs: 'Discard them', useMine: 'Restore them' }}
          onClose={() => setCompare(null)}
          onTheirs={discardDraft}
          onMine={restoreDraft}
        />
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {saveNews}
      </span>
      {captureOpen && <CaptureBox onCapture={captureIdea} onClose={() => setCaptureOpen(false)} />}
      {thinkingOpen && loaded && <ThinkingSpace doc={loaded.path} title={title} onClose={closeThinking} />}

      {exporting && (
        <ExportSheet
          path={exporting}
          kind={exportKind(files.find((f) => f.path === exporting)?.platform ?? (exporting === loaded?.path ? loaded.meta.platform : undefined))}
          files={files}
          flush={flush}
          onSaved={refreshFiles}
          onClose={closeExport}
        />
      )}

      {(sparksOpen || sparksMounted) && (
        <SparksPage
          open={sparksOpen}
          doc={loaded && !voiceView ? loaded.path : null}
          docTitle={title}
          platform={platform}
          ceiling={ceiling}
          onOpenDoc={(p) => {
            setSparksOpen(false)
            openDoc(p)
            notify('Your sparks are still there', () => setSparksOpen(true), 'Back to Sparks')
          }}
          onStarted={startedFromSpark}
          onClose={() => setSparksOpen(false)}
        />
      )}

      {overlay === 'palette' && <Palette whyNot={whyNot} run={runFromPalette} recent={recentCommands} onClose={closeOverlay} />}
      {overlay === 'switcher' && (
        <Switcher
          files={pages}
          current={voiceView || ideasView || brainView ? null : path}
          recent={recentDocs}
          onOpen={(p) => {
            if (p === path && !voiceView && !ideasView && !brainView) return closeOverlay()
            setOverlay(null)
            openDoc(p)
          }}
          onCreate={(title) => {
            setOverlay(null)
            createPage(title)
          }}
          onClose={closeOverlay}
        />
      )}

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

      {importing && (
        <ImportSheet
          files={importing.files}
          pick={importing.pick}
          folders={[...new Set(files.map((f) => f.folder))]}
          onClose={importClosed}
          onImported={importDone}
          onUndone={importUndone}
          onProgress={setImportProgress}
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
          {importProgress && <span className="status-progress">{importProgress}</span>}
          {importProgress && loaded && ' · '}
          {loaded && (
            <>
              {platformLabel(platform)} · Ceiling {ceiling}
              {/* The count is the writer's to hide (Settings · Appearance), but a limit they set themselves stays, so they can still see when they're over it. */}
              {(settings?.wordCount !== false || !!loaded.meta.target) && (
                <>
                  {' · '}
                  <span className="word-count" title={readingTimes(format?.selectedWords || words) || undefined}>
                    {!voiceView ? (
                      <LimitStatus
                        key={loaded.key}
                        store={fileText}
                        target={loaded.meta.target ?? ''}
                        selectedWords={selectedCounted}
                        skipReferences={skipReferences}
                        pages={sheet ? sheetPages : null}
                        ceiling={ceiling}
                        mod={mod}
                        paper={docSet.paper}
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
            </>
          )}
        </span>
        {showCaretTip ? (
          <span className="caret-tip" role="note">
            Nothing selected? {mod}3 next word · {mod}4 next sentence · {mod}5 continues the paragraph{mod === '⌘' ? ' (or ⌥)' : ''}
            <button className="caret-tip-close" title="Got it" aria-label="Dismiss tip" onClick={() => setCaretTipSeen(true)}>
              ✕
            </button>
          </span>
        ) : (
          <span className="muted">
            {mod}1 Recall · {mod}2 Nudge · {mod}3 Word · {mod}4 Sentence · {mod}5 Passage
          </span>
        )}
      </footer>
    </div>
  )
}

const platformLabel = (p: string) => kindName(kinds(), p)

const SAVE_LABEL: Record<SaveState, string> = { saved: 'Saved', saving: 'Saving…', unsaved: 'Edited', failed: 'Not saved', conflict: 'Not saved', gone: 'Not saved' }

/**
 * Saved / Saving… / Edited / Not saved · Retry. Not a live region: announcing every typing pause would
 * talk over dictation and screen readers. Only a save going wrong, and coming right, is announced (saveNews).
 */
function SaveChip({ state, onRetry, floating }: { state: SaveState; onRetry: () => void; floating?: boolean }) {
  return (
    <span className={`save-state is-${state}${floating ? ' is-floating' : ''}`}>
      {state === 'failed' ? (
        <>
          Not saved ·{' '}
          <button className="save-retry" title="Try saving again now (it also retries by itself)" onClick={onRetry}>
            Retry
          </button>
        </>
      ) : (
        SAVE_LABEL[state]
      )}
    </span>
  )
}

/** 14:05 today, or 3 Nov 14:05. */
function whenKept(at: number) {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

/** The kind an export starts from: a LinkedIn piece starts on Copy for LinkedIn. */
function exportKind(platform: string | undefined) {
  const id = (platform ?? 'essay').toLowerCase()
  const k = findKind(kinds(), id)
  return { id, name: k?.name ?? id }
}

/** The document title, edited in place. Return or ↓ moves on to the text. */
function TitleField({
  value,
  autoFocus,
  spellcheck,
  readOnly = false,
  onCommit,
  onHelp,
}: {
  value: string
  autoFocus: boolean
  spellcheck: boolean
  /** The title lives in front matter Ekdanta can't rewrite: shown, not edited. */
  readOnly?: boolean
  onCommit: (t: string) => void
  onHelp: (level: Level) => void
}) {
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
      contentEditable={readOnly ? false : 'plaintext-only'}
      aria-readonly={readOnly || undefined}
      title={readOnly ? "The title is in front matter Ekdanta can't edit; see Properties" : undefined}
      spellCheck={spellcheck}
      suppressContentEditableWarning
      role="textbox"
      aria-label="Title"
      data-placeholder="Untitled"
      onBlur={commit}
      onKeyDown={(e) => {
        // A help key never types into the title (⌥3 is # on a Mac). ⌘3 may draw a title from the draft;
        // the others run in the text (or, in the Markdown view, say where help works). The title is committed first, so it's current when help reads it.
        const level = helpLevel(e.nativeEvent)
        if (level) {
          e.preventDefault()
          if (e.metaKey) noteCmdWorks()
          commit()
          onHelp(level)
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
