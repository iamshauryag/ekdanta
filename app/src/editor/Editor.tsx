import { useEffect, useMemo, useRef, useState } from 'react'
import { Extension, type Editor as TiptapEditor } from '@tiptap/core'
import { EditorContent, useEditor, type UseEditorOptions } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { redoDepth, undoDepth } from '@tiptap/pm/history'
import { COMMANDS, binding, matches, titled } from '../lib/keys.ts'
import { blockOf, marksOf, runCommand, type Block, type Mark } from './commands.ts'
import { HelpController, type HistoryItem } from './controller.ts'
import { helpKey, helpOf, helpPlugin, noteCmdWorks, paragraphAt, textOf, type Help, type Level } from './help.ts'
import { parseMarkdown, serializeMarkdown, type Source } from './markdown.ts'
import { PageLinkMenu, SlashMenu, type PageRef } from './menus.ts'
import { extensions, resolver } from './schema.ts'
import { readAloudPlugin } from './readAloud.ts'
import { ReadAloudBar, canReadAloud, readAloud, useReadAloud } from '../components/ReadAloudBar.tsx'
import { replaceAll, replaceCurrent, searchPlugin, searchState, setSearch, step } from './search.ts'

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
  inTable: boolean
}

interface Props {
  docKey: string // changes when a different document opens
  /** The document's Markdown, without its front-matter. */
  initial: string
  onChange: (markdown: string) => void
  doc: () => string
  platform: () => string
  ceiling: () => number
  recallDot: () => boolean
  record: (item: HistoryItem) => void
  openDoc: (path: string) => void
  onWordCount: (n: number) => void
  autoFocus?: boolean
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
  /** The document's language (front matter `lang`), so read-aloud picks a voice for it. */
  lang?: () => string | undefined
  /** Read aloud was asked for, but this browser has no voices to read with. */
  onReadUnavailable?: () => void
}

/** Which help level a keydown asks for: ⌥1–⌥5 everywhere, ⌘1–⌘5 where the browser allows it. */
function helpLevel(e: KeyboardEvent): Level | null {
  const m = e.code.match(/^Digit([1-5])$/)
  if (!m || e.shiftKey || e.ctrlKey) return null
  if (e.altKey !== e.metaKey) return Number(m[1]) as Level
  return null
}

// Commands that act on the page (the rest of lib/keys.ts is handled by the app).
const EDITOR_COMMANDS = COMMANDS.filter((c) => c.group !== 'App' && c.id !== 'save').map((c) => c.id)

export const countWords = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

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
  const lastReport = useRef({ format: '', outline: '' })
  const editorRef = useRef<TiptapEditor | null>(null)
  const [find, setFind] = useState(false)
  const [link, setLink] = useState<{ href: string; x: number; y: number } | null>(null)

  resolver.pageTitle = (target) => p().pages().find((pg) => pg.target === target || pg.target.split('/').pop() === target)?.title
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
          addProseMirrorPlugins: () => [helpPlugin(), searchPlugin(), currentBlock, readAloudPlugin(), new Plugin({ props: { handleKeyDown: (_view, e) => onKey(e) } })],
        }),
        SlashMenu,
        PageLinkMenu.configure({ pages: () => p().pages() }),
      ],
      editorProps: {
        attributes: { class: 'pm', spellcheck: 'true', 'aria-label': 'Document' },
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
        p().onChange(serializeMarkdown(editor.state.doc, source.current))
        report(editor)
      },
      onTransaction: ({ editor, transaction }) => {
        if (editor !== editorRef.current) return
        // Typing over a suggestion dismisses it; note that in the history.
        const now = helpOf(editor.state)
        const before = lastHelp.current
        if (before && !now && transaction.docChanged && !transaction.getMeta(helpKey) && 'level' in before && !['loading', 'notice', 'bar'].includes(before.kind)) {
          p().record({ level: before.level as Level, at: new Date().toISOString(), from: before.from, outcome: 'dismissed' })
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
      ceiling: () => p().ceiling(),
      record: (item) => p().record(item),
      openDoc: (path) => p().openDoc(path),
    })
    p().onEditor?.(editor)
    report(editor)
    format(editor)
    if (p().autoFocus !== false) editor.commands.focus('start')
    return () => {
      if (editorRef.current === editor) editorRef.current = null
      controller.current = null
      p().onEditor?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  function report(ed: TiptapEditor) {
    const doc = ed.state.doc
    p().onWordCount(countWords(textOf(doc, 0, doc.content.size)))
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
      selectedWords: sel.empty ? 0 : countWords(textOf(ed.state.doc, sel.from, sel.to)),
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
      if (e.key === 'Escape' || (mod && e.key === '0')) {
        c.dismiss()
        return true
      }
      if (h.kind === 'word' || h.kind === 'recall') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return c.moveSelection(e.key === 'ArrowDown' ? 1 : -1)
        if ((h.kind === 'word' && (e.key === 'Enter' || e.key === 'Tab') && !mod) || (h.kind === 'recall' && mod && e.key === 'Enter')) return c.pickSelected()
        if (h.kind === 'word' && /^[1-5]$/.test(e.key) && !mod && !e.altKey && Number(e.key) <= h.options.length) {
          c.moveSelection(Number(e.key) - 1 - h.sel)
          return c.pickSelected()
        }
      }
      if (h.kind === 'ghost') {
        if (e.key === 'Tab' && !mod) return c.acceptGhost()
        if (e.key === 'ArrowRight' && e.altKey) return c.acceptGhost(true)
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
    window.addEventListener('ekdanta:find', openFind)
    window.addEventListener('ekdanta:link', openLink)
    window.addEventListener('ekdanta:image', pickImage)
    return () => {
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
        shouldShow={({ editor: ed, state }) => !state.selection.empty && ed.isFocused && !helpOf(state) && !(state.selection instanceof NodeSelection) && !ed.isActive('codeBlock')}
        options={{ placement: 'top', offset: 8 }}
      >
        <SelectionBar editor={editor} canRead={canReadAloud(reading.voices)} />
      </BubbleMenu>
      <EditorContent editor={editor} />
      <LinkCard editor={editor} onEdit={(href, x, y) => setLink({ href, x, y })} openPage={(t) => p().openPage(t)} />
      {link && <LinkEditor editor={editor} at={link} onClose={() => setLink(null)} />}
      <ReadAloudBar state={reading.state} reader={reading.reader.current} />
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
        chain.setTextSelection({ from: from + lead, to: to - trail }).setLink({ href: full }).run()
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
