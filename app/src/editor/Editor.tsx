import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, redoDepth, undoDepth } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { indentUnit, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { classHighlighter } from '@lezer/highlight'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap, placeholder, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { completions, type PageRef } from './complete.ts'
import { formatKeys, formatState, formatting, highlightSyntax, type FormatState } from './format.ts'
import { onBindingsChange } from '../lib/keys.ts'
import { linkTools, livePreview, type PreviewOptions } from './livepreview.ts'
import { addImages, pasting } from './paste.ts'
import { HelpController, type HistoryItem } from './controller.ts'
import { helpField, helpOwn, noteCmdWorks, paragraphAt, recallDotField, setHelp, type Level } from './help.ts'

interface Props {
  docKey: string // changes when a different document opens
  initial: string
  onChange: (text: string) => void
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
  /** Show the page formatted (Markdown only where the caret is), or as plain Markdown. */
  livePreview: boolean
  pages: () => PageRef[]
  openPage: (target: string) => void
  saveImage: (name: string, base64: string) => Promise<string>
  /** Where an image linked from this document is served from. */
  assetUrl: (src: string) => string
  /** The editor, for the toolbar. */
  onView?: (view: EditorView | null) => void
  /** What's on at the caret (for the toolbar), and how many words are selected. */
  onFormat?: (f: EditorFormat) => void
}

export interface EditorFormat extends FormatState {
  canUndo: boolean
  canRedo: boolean
  selectedWords: number
}

const preview = new Compartment()
const keys = new Compartment()
// ⌘F belongs to the remappable "find" command; the rest of the search keys stay as they are.
const searchKeys = searchKeymap.filter((k) => k.key !== 'Mod-f')

/** Which help level a keydown asks for: ⌥1–⌥5 everywhere, ⌘1–⌘5 where the browser allows it. */
function helpLevel(e: KeyboardEvent): Level | null {
  const m = e.code.match(/^Digit([1-5])$/)
  if (!m || e.shiftKey || e.ctrlKey) return null
  if (e.altKey !== e.metaKey) return Number(m[1]) as Level
  return null
}

export function Editor(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    let controller: HelpController | null = null
    const p = () => propsRef.current
    const previewOpts: PreviewOptions = {
      assetUrl: (src) => p().assetUrl(src),
      openPage: (target) => p().openPage(target),
      pageTitle: (target) => p().pages().find((pg) => pg.target === target || pg.target.split('/').pop() === target)?.title,
    }

    const helpKeys = Prec.highest(
      EditorView.domEventHandlers({
        keydown(e) {
          const c = controller
          if (!c) return false
          const level = helpLevel(e)
          if (level) {
            e.preventDefault()
            if (e.metaKey) noteCmdWorks()
            c.request(level)
            return true
          }
          const h = c.help
          if (!h) return false
          const mod = e.metaKey || e.ctrlKey
          if (e.key === 'Escape' || (mod && e.key === '0')) {
            e.preventDefault()
            c.dismiss()
            return true
          }
          if (h.kind === 'word' || h.kind === 'recall') {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              return c.moveSelection(e.key === 'ArrowDown' ? 1 : -1)
            }
            if ((h.kind === 'word' && (e.key === 'Enter' || e.key === 'Tab') && !mod) || (h.kind === 'recall' && mod && e.key === 'Enter')) {
              e.preventDefault()
              return c.pickSelected()
            }
            if (h.kind === 'word' && /^[1-5]$/.test(e.key) && !mod && !e.altKey && Number(e.key) <= h.options.length) {
              e.preventDefault()
              c.moveSelection(Number(e.key) - 1 - h.sel)
              return c.pickSelected()
            }
          }
          if (h.kind === 'ghost') {
            if (e.key === 'Tab' && !mod) {
              e.preventDefault()
              return c.acceptGhost()
            }
            if (e.key === 'ArrowRight' && e.altKey) {
              e.preventDefault()
              return c.acceptGhost(true)
            }
          }
          if (h.kind === 'nudge' && mod && e.key === 'Enter') {
            e.preventDefault()
            c.resolve()
            return true
          }
          if (h.kind === 'diff') {
            if (mod && e.key === 'Enter') {
              e.preventDefault()
              c.finishDiff('accepted')
              return true
            }
            if (mod && e.key === 'Backspace') {
              e.preventDefault()
              c.finishDiff('rejected')
              return true
            }
            if (e.key === 'Tab') {
              e.preventDefault()
              return c.stepHunk(e.shiftKey ? -1 : 1)
            }
            if (h.focus >= 0 && !mod && (e.key === 'Enter' || e.key === 'Backspace')) {
              e.preventDefault()
              return c.decideFocused(e.key === 'Enter' ? 'accepted' : 'rejected')
            }
          }
          return false
        },
      }),
    )

    const listener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        p().onChange(u.state.doc.toString())
        p().onWordCount(countWords(u.state.doc.toString()))
        // Typing over a suggestion dismisses it; note that in the history.
        const before = u.startState.field(helpField)
        const ownChange = u.transactions.some((t) => t.annotation(helpOwn) || t.effects.some((e) => e.is(setHelp)))
        if (before && !u.state.field(helpField) && !ownChange && 'level' in before && before.kind !== 'loading' && before.kind !== 'notice') {
          p().record({ level: before.level, at: new Date().toISOString(), from: before.from, outcome: 'dismissed' })
        }
      }
      if (u.selectionSet || u.docChanged || u.transactions.length) {
        const sel = u.state.selection.main
        p().onFormat?.({
          ...formatState(u.state),
          canUndo: undoDepth(u.state) > 0,
          canRedo: redoDepth(u.state) > 0,
          selectedWords: sel.empty ? 0 : countWords(u.state.sliceDoc(sel.from, sel.to)),
        })
      }
      if (u.selectionSet || u.docChanged) {
        controller?.onCursor(p().recallDot())
        const para = paragraphAt(u.state, u.state.selection.main.head)
        p().onParagraph?.(u.state.sliceDoc(para.from, para.to))
      }
    })

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.initial,
        extensions: [
          helpKeys,
          history(),
          keys.of(formatKeys()),
          formatting,
          keymap.of([...searchKeys, ...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage, extensions: [highlightSyntax] }),
          syntaxHighlighting(classHighlighter),
          indentUnit.of('    '),
          search({ top: true }),
          highlightSelectionMatches({ minSelectionLength: 3 }),
          completions(() => p().pages()),
          pasting({ saveImage: (n, b) => p().saveImage(n, b) }),
          preview.of(previewFor(p().livePreview, previewOpts)),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', 'aria-label': 'Document' }),
          placeholder('Start writing…'),
          helpField,
          recallDotField,
          currentParagraph,
          listener,
        ],
      }),
    })
    controller = new HelpController(view, {
      doc: () => p().doc(),
      platform: () => p().platform(),
      ceiling: () => p().ceiling(),
      record: (item) => p().record(item),
      openDoc: (path) => p().openDoc(path),
    })
    p().onWordCount(countWords(props.initial))
    viewRef.current = view
    p().onView?.(view)
    // "Image" from the slash menu or the toolbar asks for a file.
    const pick = () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.multiple = true
      input.onchange = () => addImages(view, [...(input.files ?? [])], { saveImage: (n, b) => p().saveImage(n, b) })
      input.click()
    }
    view.dom.addEventListener('ekdanta:image', pick)
    // Shortcuts changed in Settings apply at once.
    const offKeys = onBindingsChange(() => view.dispatch({ effects: keys.reconfigure(formatKeys()) }))
    if (props.autoFocus !== false) view.focus()
    return () => {
      view.dom.removeEventListener('ekdanta:image', pick)
      offKeys()
      p().onView?.(null)
      viewRef.current = null
      view.destroy()
    }
    // A new document gets a fresh editor (and a fresh undo history).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey])

  // Switching between Live Preview and Markdown keeps the editor, the caret and the undo history.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const p = propsRef.current
    view.dispatch({
      effects: preview.reconfigure(
        previewFor(p.livePreview, {
          assetUrl: (src) => propsRef.current.assetUrl(src),
          openPage: (t) => propsRef.current.openPage(t),
          pageTitle: (t) => propsRef.current.pages().find((pg) => pg.target === t || pg.target.split('/').pop() === t)?.title,
        }),
      ),
    })
  }, [props.livePreview])

  return <div className="editor" ref={host} />
}

const previewFor = (live: boolean, opts: PreviewOptions) => (live ? livePreview(opts) : linkTools(opts))

/** Marks the lines of the paragraph being written, so Focus mode can dim the rest. */
const currentParagraph = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = this.build(u.view)
    }
    build(view: EditorView) {
      const { state } = view
      const para = paragraphAt(state, state.selection.main.head)
      const marks = []
      for (let n = state.doc.lineAt(para.from).number; n <= state.doc.lineAt(para.to).number; n++) {
        marks.push(Decoration.line({ class: 'cm-current-para' }).range(state.doc.line(n).from))
      }
      return Decoration.set(marks)
    }
  },
  { decorations: (v) => v.decorations },
)

export function countWords(text: string) {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, '').split(/\s+/).filter((w) => /\w/.test(w)).length
}
