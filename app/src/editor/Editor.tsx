import { useEffect, useMemo, useRef, useState } from 'react'
import { Extension, type Editor as TiptapEditor } from '@tiptap/core'
import { EditorContent, useEditor, type UseEditorOptions } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { closeHistory, redoDepth, undoDepth } from '@tiptap/pm/history'
import { COMMANDS, binding, matches, titled } from '../lib/keys.ts'
import { blockOf, marksOf, runCommand, type Block, type Mark } from './commands.ts'
import { helpLevel } from './caret.ts'
import { HelpController, type HistoryItem } from './controller.ts'
import type { EdgeSlot } from '../lib/edge.ts'
import { helpKey, helpOf, helpPlugin, noteCmdWorks, paragraphAt, textOf, type Help, type Level } from './help.ts'
import { carryGaps, parseMarkdown, serializeMarkdown, type Source } from './markdown.ts'
import { PageLinkMenu, SlashMenu, type PageRef, type TemplateItems } from './menus.ts'
import { caretFor, isPromptSelected, promptPlugin, promptRanges } from './prompts.ts'
import { extensions, resolver } from './schema.ts'
import { isReferencesHeading, type Block as CountBlock } from '../lib/targets.ts'
import { readAloudPlugin } from './readAloud.ts'
import { ReadAloudBar, canReadAloud, readAloud, useReadAloud } from '../components/ReadAloudBar.tsx'
import { replaceAll, replaceCurrent, searchPlugin, searchState, setSearch, step } from './search.ts'
import { tagsPlugin } from './tags.ts'

export interface Heading {
  level: number
  text: string
  pos: number
}

export interface EditorFormat {
  block: Block
  marks: Mark[]
  canUndo: boolean
  canRedo: boolean
  selectedWords: number
  /** Of the selected words, those in a Works Cited or References section, which a length limit leaves out. */
  selectedReferenceWords: number
  inTable: boolean
}

interface Props {
  docKey: string // changes when a different document opens
  /** The document's Markdown, without its front-matter. */
  initial: string
  onChange: (markdown: string) => void
  doc: () => string
  platform: () => string
  title: () => string
  /** The model provider in use, to name it in errors. */
  provider: () => string | null
  ceiling: () => number
  recallDot: () => boolean
  record: (item: HistoryItem) => void
  /** Keep a version of the text as it is now, before help replaces a lot of it. */
  snapshot?: (reason: string) => void
  openDoc: (path: string) => void
  onWordCount: (n: number) => void
  /** The top-level blocks with their word counts, so a word limit can leave out a Works Cited section. */
  onBlocks?: (blocks: CountBlock[]) => void
  autoFocus?: boolean
  /** Where the caret starts: an offset into `initial` (a template's {{cursor}}). */
  caret?: number | null
  /** The vault's templates, for the "/" menu. */
  templates?: TemplateItems
  /** The paragraph around the caret, whenever it may have changed. */
  onParagraph?: (text: string) => void
  pages: () => PageRef[]
  openPage: (target: string) => void
  saveImage: (name: string, base64: string) => Promise<string>
  /** Where an image linked from this document is served from. */
  assetUrl: (src: string) => string
  /** The editor, for the toolbar and the Outline. */
  onEditor?: (editor: TiptapEditor | null) => void
  onFormat?: (f: EditorFormat) => void
  onOutline?: (h: Heading[]) => void
  /** The browser's spelling check on the page (Settings · Appearance). */
  spellcheck?: boolean
  /** The document's language (front matter `lang`), so read-aloud picks a voice for it. */
  lang?: () => string | undefined
  /** Read aloud was asked for, but this browser has no voices to read with. */
  onReadUnavailable?: () => void
  /** What a title, subject or excerpt says now (for edge lines). */
  edgeCurrent?: (slot: EdgeSlot) => string
  /** Use an accepted title, subject or excerpt. */
  acceptEdge?: (slot: EdgeSlot, text: string) => void
}

// Commands that act on the page (the rest of lib/keys.ts is handled by the app).
const EDITOR_COMMANDS = COMMANDS.filter((c) => c.group !== 'App' && c.id !== 'save').map((c) => c.id)

export const countWords = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

/** Words between two positions, leaving out a template's prompts: they aren't the writer's words. */
function wordsOutsidePrompts(doc: PMNode, from: number, to: number, ranges = promptRanges(doc)) {
  const prompts = ranges.filter((r) => r.from >= from && r.to <= to).reduce((n, r) => n + countWords(textOf(doc, r.from, r.to)), 0)
  return countWords(textOf(doc, from, to)) - prompts
}

/** Selected words that sit in a references section. */
function referenceWords(doc: PMNode, from: number, to: number) {
  const ranges = referenceRanges(doc).filter((r) => r.from < to && r.to > from)
  if (!ranges.length) return 0
  const prompts = promptRanges(doc)
  return ranges.reduce((n, r) => n + wordsOutsidePrompts(doc, Math.max(from, r.from), Math.min(to, r.to), prompts), 0)
}

/**
 * Where a Works Cited, References or Bibliography section sits: from its heading up to the next heading
 * of the same or a higher level, as countable() in lib/targets.ts reads the same blocks.
 */
function referenceRanges(doc: PMNode) {
  const ranges: { from: number; to: number }[] = []
  let level = 0
  doc.forEach((n, pos) => {
    const heading = n.type.name === 'heading' ? (n.attrs.level as number) : 0
    if (heading && level && heading <= level) level = 0
    if (heading && !level && isReferencesHeading(n.textContent)) {
      level = heading
      ranges.push({ from: pos, to: pos + n.nodeSize })
    } else if (level) ranges[ranges.length - 1].to = pos + n.nodeSize
  })
  return ranges
}

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/** Marks the block the caret is in, so Focus mode can dim the rest. */
const currentBlock = new Plugin({
  key: new PluginKey('currentBlock'),
  props: {
    decorations(state) {
      const $pos = state.selection.$head
      if ($pos.depth < 1) return null
      const start = $pos.before(1)
      return DecorationSet.create(state.doc, [Decoration.node(start, start + $pos.node(1).nodeSize, { class: 'is-current' })])
    },
  },
})

export function Editor(props: Props) {
  const propsRef = useRef(props)
  propsRef.current = props
  const p = () => propsRef.current
  const controller = useRef<HelpController | null>(null)
  const source = useRef<Source | undefined>(undefined)
  const lastHelp = useRef<Help | null>(null)
  const lastReport = useRef({ format: '', outline: '', blocks: '' })
  const editorRef = useRef<TiptapEditor | null>(null)
  const [find, setFind] = useState(false)
  const [link, setLink] = useState<{ href: string; x: number; y: number } | null>(null)

  resolver.pageTitle = (target) =>
    p()
      .pages()
      .find((pg) => pg.target === target || pg.target.split('/').pop() === target)?.title
  resolver.assetUrl = (src) => p().assetUrl(src)

  // Made once per document: new options on every render would make the editor reconfigure itself,
  // report its state, and render again, forever. Everything inside reads the latest props via p().
  const options = useMemo<UseEditorOptions>(
    () => ({
      extensions: [
        ...extensions(),
        Extension.create({
          name: 'ekdanta',
          // Ahead of every other key handler: help first, then the writer's own shortcuts.
          priority: 1000,
          addProseMirrorPlugins: () => [helpPlugin(), searchPlugin(), promptPlugin(), tagsPlugin(), currentBlock, readAloudPlugin(), new Plugin({ props: { handleKeyDown: (_view, e) => onKey(e) } })],
        }),
        SlashMenu.configure({
          templates: { list: () => p().templates?.list() ?? [], insert: (t) => p().templates?.insert(t), browse: () => p().templates?.browse() },
        }),
        PageLinkMenu.configure({ pages: () => p().pages() }),
      ],
      editorProps: {
        // A function, so a change in Settings reaches the page without remaking the editor (see below).
        attributes: () => ({ class: 'pm', spellcheck: p().spellcheck === false ? 'false' : 'true', 'aria-label': 'Document' }),
        handlePaste: (_view, e) => {
          const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
          if (!images.length) return false
          addImages(images)
          return true
        },
        handleDrop: (view, e) => {
          const images = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
          if (!images.length) return false
          e.preventDefault()
          addImages(images, view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos)
          return true
        },
        handleClick: (_view, _pos, e) => {
          // ⌘-click (Ctrl-click) opens a link; a plain click puts the caret in it, so it can be edited.
          if (!(e.metaKey || e.ctrlKey)) return false
          const t = e.target as HTMLElement
          const page = t.closest<HTMLElement>('[data-page]')
          if (page) {
            p().openPage(page.dataset.page!)
            return true
          }
          const a = t.closest('a')
          if (a?.href) {
            window.open(a.href, '_blank', 'noopener')
            return true
          }
          return false
        },
      },
      onUpdate: ({ editor, transaction }) => {
        if (transaction.getMeta('ekdanta-load') || editor !== editorRef.current) return
        // A restored version brings the source of its blocks, so it's written back exactly as it was kept.
        // The old blocks' source stays too, for ⌘Z.
        const restored = transaction.getMeta('ekdanta-source') as Source | undefined
        if (restored)
          source.current = {
            prefix: restored.prefix,
            blocks: new Map([...(source.current?.blocks ?? []), ...restored.blocks]),
            last: restored.last,
            gaps: new Map([...(source.current?.gaps ?? []), ...restored.gaps]),
            follows: new Map([...(source.current?.follows ?? []), ...restored.follows]),
          }
        p().onChange(serializeMarkdown(editor.state.doc, source.current))
        report(editor)
      },
      onTransaction: ({ editor, transaction }) => {
        if (editor !== editorRef.current) return
        // Edited blocks keep the blank lines the file had after them (before onUpdate writes the file).
        if (source.current && !transaction.getMeta('ekdanta-load')) carryGaps(transaction.before, editor.state.doc, source.current)
        // Typing over a suggestion dismisses it; note that in the history.
        const now = helpOf(editor.state)
        const before = lastHelp.current
        if (before && !now && transaction.docChanged && !transaction.getMeta(helpKey) && 'level' in before && !['loading', 'notice', 'bar'].includes(before.kind)) {
          controller.current?.noteDismissed(before)
        }
        lastHelp.current = now
        if (transaction.docChanged || transaction.selectionSet) {
          controller.current?.onCursor(p().recallDot())
          const para = paragraphAt(editor.state, editor.state.selection.head)
          p().onParagraph?.(textOf(editor.state.doc, para.from, para.to))
        }
        format(editor)
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.docKey],
  )
  const editor = useEditor(options, [props.docKey])
  const reading = useReadAloud(editor, { lang: () => p().lang?.(), onUnavailable: () => p().onReadUnavailable?.() })

  // ProseMirror sets the editor's attributes whenever its state updates; ask it to, now.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.updateState(editor.view.state)
  }, [editor, props.spellcheck])

  // Everything is tied to the editor actually on the page. (In development React mounts components
  // twice, so an editor created first may already be gone.)
  useEffect(() => {
    if (!editor) return
    editorRef.current = editor
    // The file, read into the document model. Untouched blocks keep their identity, so they're
    // written back exactly as they were (see markdown.ts).
    const { doc, source: src } = parseMarkdown(editor.schema, p().initial)
    editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content).setMeta('addToHistory', false).setMeta('ekdanta-load', true))
    const kept = new Set<unknown>()
    editor.state.doc.forEach((n) => kept.add(n))
    source.current = { ...src, blocks: new Map([...src.blocks].filter(([n]) => kept.has(n))), last: src.last && kept.has(src.last) ? src.last : null }
    controller.current = new HelpController(editor.view, {
      doc: () => p().doc(),
      platform: () => p().platform(),
      title: () => p().title(),
      provider: () => p().provider(),
      ceiling: () => p().ceiling(),
      record: (item) => p().record(item),
      snapshot: (reason) => p().snapshot?.(reason),
      openDoc: (path) => p().openDoc(path),
      edgeCurrent: (slot) => p().edgeCurrent?.(slot) ?? '',
      acceptEdge: (slot, text) => p().acceptEdge?.(slot, text),
    })
    p().onEditor?.(editor)
    report(editor)
    format(editor)
    const caret = p().caret
    if (caret != null && caret >= 0 && caret <= p().initial.length) {
      // A template's {{cursor}}: the caret goes there (a prompt there is selected, ready to be typed over).
      const c = caretFor(editor.schema, editor.state.doc, 0, p().initial, caret)
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, c.from, c.to)).scrollIntoView())
      editor.view.focus()
    } else if (p().autoFocus !== false) {
      // A piece opens at its top. Scrolling to the first line instead would pass over what sits above it
      // in page view: an APA or Chicago title page.
      editor.commands.focus('start', { scrollIntoView: false })
      editor.view.dom.closest('.page-area')?.scrollTo({ top: 0 })
    }
    return () => {
      if (editorRef.current === editor) editorRef.current = null
      controller.current = null
      p().onEditor?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  function report(ed: TiptapEditor) {
    const doc = ed.state.doc
    // Counted block by block (prompts left out, block boundaries are spaces either way), so the total and the parts agree.
    const prompts = promptRanges(doc)
    const blocks: CountBlock[] = []
    doc.forEach((n, pos) =>
      blocks.push({ heading: n.type.name === 'heading' ? n.attrs.level : 0, text: n.type.name === 'heading' ? n.textContent : '', words: wordsOutsidePrompts(doc, pos, pos + n.nodeSize, prompts) }),
    )
    p().onWordCount(blocks.reduce((sum, b) => sum + b.words, 0))
    const blocksKey = JSON.stringify(blocks)
    if (blocksKey !== lastReport.current.blocks) {
      lastReport.current.blocks = blocksKey
      p().onBlocks?.(blocks)
    }
    const outline: Heading[] = []
    doc.descendants((n, pos) => {
      if (n.type.name === 'heading') outline.push({ level: n.attrs.level, text: n.textContent, pos })
      return n.isBlock && !n.isTextblock
    })
    const key = JSON.stringify(outline)
    if (key !== lastReport.current.outline) {
      lastReport.current.outline = key
      p().onOutline?.(outline)
    }
  }

  function format(ed: TiptapEditor) {
    const sel = ed.state.selection
    const f: EditorFormat = {
      block: blockOf(ed),
      marks: marksOf(ed),
      canUndo: undoDepth(ed.state) > 0,
      canRedo: redoDepth(ed.state) > 0,
      selectedWords: sel.empty ? 0 : wordsOutsidePrompts(ed.state.doc, sel.from, sel.to),
      selectedReferenceWords: sel.empty ? 0 : referenceWords(ed.state.doc, sel.from, sel.to),
      inTable: ed.isActive('table'),
    }
    // Only when something the toolbar shows has changed, not on every keystroke.
    const key = JSON.stringify(f)
    if (key !== lastReport.current.format) {
      lastReport.current.format = key
      p().onFormat?.(f)
    }
  }

  async function addImages(files: File[], at?: number) {
    const ed = editorRef.current
    if (!ed) return
    for (const file of files) {
      const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png'
      const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${new Date().toISOString().slice(0, 10)}.${ext}`
      const src = await p().saveImage(name, await readAsBase64(file))
      const alt = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
      const chain = ed.chain().focus()
      if (at !== undefined) chain.setTextSelection(at)
      chain.insertContent({ type: 'image', attrs: { src, alt } }).run()
    }
  }

  /** Every key on the page: the help ladder's first, then the writer's (remappable) shortcuts. */
  function onKey(e: KeyboardEvent): boolean {
    const c = controller.current
    const ed = editorRef.current
    if (!c || !ed) return false
    const level = helpLevel(e)
    if (level) {
      e.preventDefault()
      if (e.metaKey) noteCmdWorks()
      c.request(level)
      return true
    }
    const h = c.help
    const mod = e.metaKey || e.ctrlKey
    if (h) {
      if (e.key === 'Escape' || matches(e, binding('dismissHelp'))) {
        c.dismiss()
        return true
      }
      if (h.kind === 'word' || h.kind === 'recall' || h.kind === 'edge') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return c.moveSelection(e.key === 'ArrowDown' ? 1 : -1)
        if (((h.kind === 'word' || h.kind === 'edge') && (e.key === 'Enter' || e.key === 'Tab') && !mod) || (h.kind === 'recall' && mod && e.key === 'Enter')) return c.pickSelected()
        if ((h.kind === 'word' || h.kind === 'edge') && /^[1-5]$/.test(e.key) && !mod && !e.altKey && Number(e.key) <= h.options.length) {
          c.moveSelection(Number(e.key) - 1 - h.sel)
          return c.pickSelected()
        }
      }
      if (h.kind === 'ghost') {
        if (e.key === 'Tab' && !mod && !e.shiftKey) return c.acceptGhost()
        if (e.key === 'ArrowRight' && e.altKey) return c.acceptGhost('word')
        if (e.key === 'Enter' && mod) return c.acceptGhost('all')
      }
      if (h.kind === 'nudge' && mod && e.key === 'Enter') {
        c.resolve()
        return true
      }
      if (h.kind === 'diff') {
        if (mod && (e.key === 'Enter' || e.key === 'Backspace')) {
          c.finishDiff(e.key === 'Enter' ? 'accepted' : 'rejected')
          return true
        }
        if (e.key === 'Tab') return c.stepHunk(e.shiftKey ? -1 : 1)
        if (h.focus >= 0 && !mod && (e.key === 'Enter' || e.key === 'Backspace')) return c.decideFocused(e.key === 'Enter' ? 'accepted' : 'rejected')
      }
    }
    for (const id of EDITOR_COMMANDS) {
      if (matches(e, binding(id))) {
        e.preventDefault()
        runCommand(ed, id)
        return true
      }
    }
    // Tab nests list items and moves between table cells; elsewhere it stays on the page.
    if (e.key === 'Tab' && !mod && !e.altKey && !ed.isActive('listItem') && !ed.isActive('taskItem') && !ed.isActive('table') && !ed.isActive('codeBlock')) return true
    return false
  }

  // The toolbar, the "/" menu and ⌘K/⌘F ask for these.
  useEffect(() => {
    const openFind = () => setFind(true)
    const openLink = () => {
      const ed = editorRef.current
      if (!ed) return
      const at = ed.view.coordsAtPos(ed.state.selection.from)
      setLink({ href: ed.getAttributes('link').href ?? '', x: at.left, y: at.bottom + 6 })
    }
    const pickImage = () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.multiple = true
      input.onchange = () => addImages([...(input.files ?? [])])
      input.click()
    }
    // Restoring a version: the whole body in one transaction, so ⌘Z brings back what was there.
    const replaceBody = (e: Event) => {
      const ed = editorRef.current
      if (!ed) return
      const { doc, source: src } = parseMarkdown(ed.schema, (e as CustomEvent<{ body: string }>).detail.body)
      // Its own undo step, even straight after typing.
      const tr = closeHistory(ed.state.tr).replaceWith(0, ed.state.doc.content.size, doc.content)
      const kept = new Set<unknown>()
      tr.doc.forEach((n) => kept.add(n))
      tr.setMeta('ekdanta-source', { ...src, blocks: new Map([...src.blocks].filter(([n]) => kept.has(n))), last: src.last && kept.has(src.last) ? src.last : null })
      ed.view.dispatch(tr.setMeta(helpKey, { help: null }).scrollIntoView())
      ed.commands.focus('start')
    }
    // A help key pressed in the title, and 'Suggest from my draft' beside a field: both run here.
    const fromTitle = (e: Event) => {
      const level = (e as CustomEvent<{ level: Level }>).detail?.level
      if (level) controller.current?.requestFromTitle(level)
    }
    const edge = (e: Event) => {
      const slot = (e as CustomEvent<{ slot: EdgeSlot }>).detail?.slot
      const c = controller.current
      if (!slot || !c) return
      editorRef.current?.view.focus()
      // Asking again while the card is open leaves out what it already showed.
      const h = c.help
      c.fetchEdge(slot, h?.kind === 'edge' && h.slot === slot ? [...h.seen, ...h.options.map((o) => o.text)] : [])
    }
    window.addEventListener('ekdanta:help', fromTitle)
    window.addEventListener('ekdanta:edge', edge)
    window.addEventListener('ekdanta:find', openFind)
    window.addEventListener('ekdanta:link', openLink)
    window.addEventListener('ekdanta:image', pickImage)
    window.addEventListener('ekdanta:replace-body', replaceBody)
    return () => {
      window.removeEventListener('ekdanta:replace-body', replaceBody)
      window.removeEventListener('ekdanta:help', fromTitle)
      window.removeEventListener('ekdanta:edge', edge)
      window.removeEventListener('ekdanta:find', openFind)
      window.removeEventListener('ekdanta:link', openLink)
      window.removeEventListener('ekdanta:image', pickImage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!editor) return null
  return (
    <div className="editor">
      {find && <FindBar editor={editor} onClose={() => setFind(false)} />}
      <BubbleMenu
        editor={editor}
        shouldShow={({ editor: ed, state }) =>
          !state.selection.empty && !isPromptSelected(state) && ed.isFocused && !helpOf(state) && !(state.selection instanceof NodeSelection) && !ed.isActive('codeBlock')
        }
        options={{ placement: 'top', offset: 8 }}
      >
        <SelectionBar editor={editor} canRead={canReadAloud(reading.voices)} />
      </BubbleMenu>
      <EditorContent editor={editor} />
      <LinkCard editor={editor} onEdit={(href, x, y) => setLink({ href, x, y })} openPage={(t) => p().openPage(t)} />
      {link && <LinkEditor editor={editor} at={link} onClose={() => setLink(null)} />}
      <ReadAloudBar state={reading.state} reader={reading.reader.current} online={reading.online} />
    </div>
  )
}

/** Re-render a component on every editor transaction (for UI that shows the editor's state). */
function useEditorTick(editor: TiptapEditor, events: ('transaction' | 'focus' | 'blur')[] = ['transaction']) {
  const [, redraw] = useState(0)
  useEffect(() => {
    const on = () => redraw((n) => n + 1)
    events.forEach((ev) => editor.on(ev, on))
    return () => events.forEach((ev) => editor.off(ev, on))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])
}

// ---- The bar over a selection (as in Notion and Medium) --------------------------------------

const BAR: { label: string; name: string; id: string; mark: Mark; cls: string }[] = [
  { label: 'B', name: 'Bold', id: 'bold', mark: 'bold', cls: 'is-b' },
  { label: 'I', name: 'Italic', id: 'italic', mark: 'italic', cls: 'is-i' },
  { label: 'U', name: 'Underline', id: 'underline', mark: 'underline', cls: 'is-u' },
  { label: 'S', name: 'Strikethrough', id: 'strike', mark: 'strike', cls: 'is-s' },
  { label: '</>', name: 'Code', id: 'code', mark: 'code', cls: 'is-code' },
  { label: 'H', name: 'Highlight', id: 'highlight', mark: 'highlight', cls: 'is-hl' },
  { label: 'Link', name: 'Link', id: 'link', mark: 'link', cls: 'is-link' },
]

function SelectionBar({ editor, canRead }: { editor: TiptapEditor; canRead: boolean }) {
  useEditorTick(editor)
  const on = marksOf(editor)
  return (
    <div className="fmt-bar">
      {BAR.map((b) => (
        <button
          key={b.id}
          className={b.cls + (on.includes(b.mark) ? ' is-on' : '')}
          title={titled(b.name, b.id)}
          onMouseDown={(e) => {
            e.preventDefault()
            runCommand(editor, b.id)
          }}
        >
          {b.label}
        </button>
      ))}
      {canRead && (
        <button
          className="is-read"
          title={titled('Read aloud', 'readAloud')}
          aria-label="Read aloud"
          onMouseDown={(e) => {
            e.preventDefault()
            readAloud()
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 6v4h2.5l3.5 3V3L5 6zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.6a6 6 0 0 1 0 8.8" />
          </svg>
        </button>
      )}
    </div>
  )
}

// ---- Links: the card under one (as in Google Docs), and the box for its address -------------------

function LinkCard({ editor, onEdit, openPage }: { editor: TiptapEditor; onEdit: (href: string, x: number, y: number) => void; openPage: (t: string) => void }) {
  useEditorTick(editor, ['transaction', 'focus', 'blur'])
  const { state } = editor
  const sel = state.selection
  const page = sel instanceof NodeSelection && sel.node.type.name === 'pageLink' ? sel.node : null
  const inLink = sel.empty && editor.isActive('link')
  if (!editor.isFocused || (!page && !inLink) || helpOf(state)) return null
  const at = editor.view.coordsAtPos(sel.from)
  const href: string = inLink ? (editor.getAttributes('link').href ?? '') : ''
  const title = page ? resolver.pageTitle(page.attrs.target) : undefined
  const keep = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault()
    fn()
  }
  return (
    <div className="link-card" style={{ left: at.left, top: at.bottom + 6 }}>
      <span className="link-card-target">{page ? (title ?? `${page.attrs.target} (no such page yet)`) : href}</span>
      {page ? (
        <>
          <button onMouseDown={keep(() => openPage(page.attrs.target))}>{title ? 'Open' : 'Create'}</button>
          <button
            title="Keep the text, remove the link"
            onMouseDown={keep(() =>
              editor
                .chain()
                .focus()
                .insertContentAt({ from: sel.from, to: sel.to }, page.attrs.label || title || page.attrs.target)
                .run(),
            )}
          >
            Remove
          </button>
        </>
      ) : (
        <>
          {/^(https?:|mailto:)/i.test(href) && <button onMouseDown={keep(() => window.open(href, '_blank', 'noopener'))}>Open</button>}
          <button onMouseDown={keep(() => onEdit(href, at.left, at.bottom + 6))}>Edit</button>
          <button title="Copy the address" onMouseDown={keep(() => navigator.clipboard?.writeText(href))}>
            Copy
          </button>
          <button title="Keep the text, remove the link" onMouseDown={keep(() => editor.chain().focus().extendMarkRange('link').unsetLink().run())}>
            Remove
          </button>
        </>
      )}
    </div>
  )
}

function LinkEditor({ editor, at, onClose }: { editor: TiptapEditor; at: { href: string; x: number; y: number }; onClose: () => void }) {
  const [href, setHref] = useState(at.href)
  const apply = () => {
    const url = href.trim()
    const chain = editor.chain().focus()
    if (!url) chain.extendMarkRange('link').unsetLink().run()
    else {
      const full = /^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`
      // Nothing selected and no link here: the address becomes the link's text.
      const { from, to, empty } = editor.state.selection
      if (empty && !editor.isActive('link')) chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: full } }] }).run()
      else if (empty) chain.extendMarkRange('link').setLink({ href: full }).run()
      else {
        // A link starts and ends on words, never on the spaces around them.
        const text = editor.state.doc.textBetween(from, to)
        const lead = text.length - text.trimStart().length
        const trail = text.length - text.trimEnd().length
        chain
          .setTextSelection({ from: from + lead, to: to - trail })
          .setLink({ href: full })
          .run()
      }
    }
    onClose()
  }
  return (
    <div className="link-editor" style={{ left: at.x, top: at.y }}>
      <input
        autoFocus
        value={href}
        placeholder="Paste or type a link"
        aria-label="Link address"
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            apply()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
            editor.commands.focus()
          }
        }}
        onBlur={onClose}
      />
      <button
        onMouseDown={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        {href.trim() ? 'Apply' : at.href ? 'Remove' : 'Cancel'}
      </button>
    </div>
  )
}

// ---- Find and replace -------------------------------------------------------------------------

function FindBar({ editor, onClose }: { editor: TiptapEditor; onClose: () => void }) {
  const view = editor.view
  const [query, setQuery] = useState(() => {
    const sel = editor.state.selection
    return sel.empty ? '' : textOf(editor.state.doc, sel.from, sel.to)
  })
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const findRef = useRef<HTMLInputElement>(null)
  useEditorTick(editor)
  useEffect(() => {
    setSearch(view, { query, matchCase, current: 0 })
  }, [query, matchCase, view])
  useEffect(() => {
    findRef.current?.select()
    return () => setSearch(view, { query: '' })
  }, [view])
  const s = searchState(view.state)
  const close = () => {
    onClose()
    editor.commands.focus()
  }
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }
  return (
    <div className="find-bar" role="search">
      <input
        ref={findRef}
        autoFocus
        value={query}
        placeholder="Find"
        aria-label="Find"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          keys(e)
          if (e.key === 'Enter') {
            e.preventDefault()
            step(view, e.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="find-count">{query ? (s.matches.length ? `${s.current + 1} of ${s.matches.length}` : 'No results') : ''}</span>
      <button title="Previous (⇧↵)" onClick={() => step(view, -1)} disabled={!s.matches.length}>
        ↑
      </button>
      <button title="Next (↵)" onClick={() => step(view, 1)} disabled={!s.matches.length}>
        ↓
      </button>
      <button className={matchCase ? 'is-on' : ''} title="Match case" onClick={() => setMatchCase((m) => !m)}>
        Aa
      </button>
      <input value={replacement} placeholder="Replace with" aria-label="Replace with" onChange={(e) => setReplacement(e.target.value)} onKeyDown={keys} />
      <button onClick={() => replaceCurrent(view, replacement)} disabled={!s.matches.length}>
        Replace
      </button>
      <button onClick={() => replaceAll(view, replacement)} disabled={!s.matches.length}>
        All
      </button>
      <button className="find-close" title="Close (Esc)" onClick={close}>
        ✕
      </button>
    </div>
  )
}
