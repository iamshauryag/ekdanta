// Formatting, written as plain Markdown: the commands behind the toolbar, the bar over a selection,
// the slash menu and the keys (bound in lib/keys.ts, remappable in Settings).
import { indentLess, indentMore } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Line } from '@codemirror/state'
import { EditorView, keymap, showTooltip, type Command, type Tooltip } from '@codemirror/view'
import type { MarkdownConfig } from '@lezer/markdown'
import { tags } from '@lezer/highlight'
import { openSearchPanel } from '@codemirror/search'
import { binding, titled } from '../lib/keys.ts'
import { helpField } from './help.ts'
import { scanLine, spansAt, type Span } from './marks.ts'

// ---- ==Highlight== (Obsidian's syntax), as a Markdown extension ----------------------------

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }
const punct = /[!-/:-@[-`{-~]/

export const highlightSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight' },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1
        const before = cx.slice(pos - 1, pos)
        const after = cx.slice(pos + 2, pos + 3)
        const sBefore = /\s|^$/.test(before)
        const sAfter = /\s|^$/.test(after)
        const pBefore = punct.test(before)
        const pAfter = punct.test(after)
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter && (!pAfter || sBefore || pBefore), !sBefore && (!pBefore || sAfter || pAfter))
      },
      after: 'Emphasis',
    },
  ],
}

// ---- Inline marks ------------------------------------------------------------------------

export type Mark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight' | 'link'
type Wrapped = Exclude<Mark, 'link'>
const MARKS: Record<Wrapped, [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  underline: ['<u>', '</u>'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
  highlight: ['==', '=='],
}

/** A line's block marker: `# `, `> `, `- `, `- [ ] `, `1. `. */
export const PREFIX = /^(\s*)(#{1,6} |> ?|[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/

// ⌘B with nothing selected and no word at the caret turns bold on for what's typed next, as in
// Google Docs, without writing any marks until there is text to put inside them.
const setStored = StateEffect.define<{ at: number; mark: Wrapped } | null>()
export const storedMark = StateField.define<{ at: number; mark: Wrapped } | null>({
  create: () => null,
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(setStored)) return e.value
    return tr.docChanged || tr.selection ? null : v
  },
})

const typeStored = EditorView.inputHandler.of((view, from, to, text) => {
  const stored = view.state.field(storedMark, false)
  if (!stored || from !== to || from !== stored.at) return false
  const [open, close] = MARKS[stored.mark]
  // Spaces typed first stay outside the marks.
  const lead = text.match(/^\s*/)![0]
  const body = text.slice(lead.length)
  if (!body) return false
  view.dispatch({
    changes: { from, insert: lead + open + body + close },
    selection: EditorSelection.cursor(from + lead.length + open.length + body.length),
    userEvent: 'input.type',
  })
  return true
})

/** Wrap the selection in a mark, or take it off if it's already there. */
export const toggleMark =
  (mark: Wrapped): Command =>
  (view) => {
    const [open, close] = MARKS[mark]
    const { state } = view
    const main = state.selection.main
    if (state.selection.ranges.length === 1 && main.empty && !state.wordAt(main.head) && !spanAt(state, main.head, mark)) {
      const stored = state.field(storedMark, false)
      view.dispatch({ effects: setStored.of(stored?.mark === mark && stored.at === main.head ? null : { at: main.head, mark }) })
      view.focus()
      return true
    }
    view.dispatch(
      state.changeByRange((range) => {
        const before = state.sliceDoc(range.from - open.length, range.from)
        const after = state.sliceDoc(range.to, range.to + close.length)
        const inner = state.sliceDoc(range.from, range.to)
        // Already wrapped, just outside the selection or just inside it: take the marks off.
        if (!range.empty && before === open && after === close && !(mark === 'italic' && isBold(state, range.from - 1, range.to + 1))) {
          return {
            changes: [
              { from: range.from - open.length, to: range.from },
              { from: range.to, to: range.to + close.length },
            ],
            range: EditorSelection.range(range.from - open.length, range.to - open.length),
          }
        }
        if (inner.length >= open.length + close.length && inner.startsWith(open) && inner.endsWith(close)) {
          return { changes: { from: range.from, to: range.to, insert: inner.slice(open.length, -close.length) }, range: EditorSelection.range(range.from, range.to - open.length - close.length) }
        }
        const span = range.empty ? spanAt(state, range.head, mark) : null
        if (span) {
          // At the end of the span (only closing marks between the caret and its end), the key turns the
          // style off for what's typed next, as in Google Docs.
          if (/^[*_~=]*$/.test(state.sliceDoc(range.head, span.closeFrom))) return { range: EditorSelection.cursor(span.closeTo) }
          // Inside it: take that span's marks off.
          return {
            changes: [
              { from: span.openFrom, to: span.openTo },
              { from: span.closeFrom, to: span.closeTo },
            ],
            range: EditorSelection.cursor(Math.max(span.openFrom, range.head - (span.openTo - span.openFrom))),
          }
        }
        // Nothing selected: the word at the caret, or an empty pair to type into.
        const word = range.empty ? state.wordAt(range.head) : null
        if (word) {
          return {
            changes: [
              { from: word.from, insert: open },
              { from: word.to, insert: close },
            ],
            range: EditorSelection.cursor(range.head + open.length),
          }
        }
        // Spaces, and a line's own `- ` or `# `, stay outside the marks, or Markdown won't read them as formatting.
        const line = state.doc.lineAt(range.from)
        const prefix = range.from === line.from ? (line.text.match(PREFIX)?.[0].length ?? 0) : 0
        const lead = prefix + (inner.slice(prefix).length - inner.slice(prefix).trimStart().length)
        const trail = inner.length - inner.trimEnd().length
        const from = range.from + lead
        const to = Math.max(from, range.to - trail)
        return {
          changes: [
            { from, insert: open },
            { from: to, insert: close },
          ],
          range: range.empty ? EditorSelection.cursor(from + open.length) : EditorSelection.range(from + open.length, to + open.length),
        }
      }),
    )
    view.focus()
    return true
  }

const isBold = (state: EditorState, from: number, to: number) => state.sliceDoc(from - 1, from) === '*' && state.sliceDoc(to, to + 1) === '*'

type SyntaxNodeRef = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>

/** The innermost span of a kind around a position, as the writer means it (see marks.ts). */
function spanAt(state: EditorState, pos: number, mark: Wrapped): Span | null {
  if (mark === 'code') {
    for (let n: SyntaxNodeRef | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
      if (n.name === 'InlineCode' && pos > n.from && pos < n.to) {
        const ticks = state.sliceDoc(n.from, n.to).match(/^`+/)![0].length
        return { mark: 'bold', openFrom: n.from, openTo: n.from + ticks, closeFrom: n.to - ticks, closeTo: n.to }
      }
    }
    return null
  }
  const line = state.doc.lineAt(pos)
  const hits = spansAt(scanLine(line.text, line.from), pos).filter((sp) => sp.mark === mark)
  return hits.sort((a, b) => b.openTo - a.openTo)[0] ?? null
}

/** `[text](url)` with the url selected to type over, or, given a url, the link itself. */
export const insertLink =
  (url?: string): Command =>
  (view) => {
    const { state } = view
    view.dispatch(
      state.changeByRange((range) => {
        const text = state.sliceDoc(range.from, range.to) || url || 'link'
        const target = url ?? 'https://'
        const insert = `[${text}](${target})`
        if (url) return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) }
        const urlAt = range.from + text.length + 3
        return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(urlAt, urlAt + target.length) }
      }),
    )
    view.focus()
    return true
  }

/** A link's text stays; the link goes. */
export function unlink(view: EditorView, from: number, to: number) {
  const text = view.state.sliceDoc(from, to)
  const plain = text.match(/^\[\[(?:[^\]|]*\|)?([^\]]*)\]\]$/)?.[1] ?? text.match(/^\[([^\]]*)\]\([^)]*\)$/)?.[1] ?? text
  view.dispatch({ changes: { from, to, insert: plain } })
  view.focus()
}

// ---- Blocks ------------------------------------------------------------------------------

export type Block = 'p' | 'h1' | 'h2' | 'h3' | 'quote' | 'bullet' | 'number' | 'todo' | 'code'
const BLOCK_PREFIX: Record<Exclude<Block, 'code' | 'number'>, string> = { p: '', h1: '# ', h2: '## ', h3: '### ', quote: '> ', bullet: '- ', todo: '- [ ] ' }

export function blockOf(text: string): Block {
  const m = text.match(PREFIX)
  if (!m) return 'p'
  const p = m[2]
  if (p.startsWith('#')) return p.length === 2 ? 'h1' : p.length === 3 ? 'h2' : 'h3'
  if (p.startsWith('>')) return 'quote'
  if (/\[[ xX]\]/.test(p)) return 'todo'
  if (/^\d/.test(p)) return 'number'
  return 'bullet'
}

function selectedLines(state: EditorState): Line[] {
  const seen = new Map<number, Line>()
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) seen.set(l, state.doc.line(l))
  }
  return [...seen.values()]
}

/** Turn the selected lines into a kind of block. Asking for the kind they already are turns them back into text. */
export const setBlock =
  (kind: Block, toggle = true): Command =>
  (view) => {
    const { state } = view
    if (kind === 'code') return codeBlock(view)
    const lines = selectedLines(state)
    const target = toggle && lines.every((l) => blockOf(l.text) === kind) ? 'p' : kind
    let n = 0
    const changes = lines.map((line) => {
      const m = line.text.match(PREFIX)
      const indent = m?.[1] ?? ''
      const existing = m ? m[0].length : 0
      // Headings and quotes don't nest; lists keep their indentation.
      const keep = target === 'bullet' || target === 'number' || target === 'todo' ? indent : ''
      const insert = keep + (target === 'number' ? `${++n}. ` : BLOCK_PREFIX[target])
      return { from: line.from, to: line.from + existing, insert }
    })
    // A caret at the start of the line ends up after the new marker, ready to type.
    const set = state.changes(changes)
    view.dispatch({ changes: set, selection: state.selection.map(set, 1), scrollIntoView: true })
    view.focus()
    return true
  }

function codeBlock(view: EditorView) {
  const { state } = view
  const lines = selectedLines(state)
  const first = lines[0]
  const last = lines[lines.length - 1]
  // Already fenced: take the fences off.
  const above = first.number > 1 ? state.doc.line(first.number - 1) : null
  const below = last.number < state.doc.lines ? state.doc.line(last.number + 1) : null
  if (above?.text.startsWith('```') && below?.text.startsWith('```')) {
    view.dispatch({
      changes: [
        { from: above.from, to: first.from },
        { from: last.to, to: below.to },
      ],
    })
    return true
  }
  const empty = first === last && !first.text.trim()
  view.dispatch({
    changes: [
      { from: first.from, insert: '```\n' },
      { from: last.to, insert: '\n```' },
    ],
    selection: empty ? EditorSelection.cursor(first.from + 4) : undefined,
  })
  view.focus()
  return true
}

/** Check or uncheck the to-do on each selected line. */
export const toggleTask: Command = (view) => {
  const changes = selectedLines(view.state).flatMap((line) => {
    const m = line.text.match(/^(\s*[-*+] \[)([ xX])\]/)
    if (!m) return []
    const at = line.from + m[1].length
    return [{ from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' }]
  })
  if (!changes.length) return false
  view.dispatch({ changes })
  return true
}

const inList = (state: EditorState) => selectedLines(state).every((l) => /^\s*([-*+]|\d+[.)]) /.test(l.text))

/** Tab nests a list item; elsewhere it's left to the help ladder (which accepts ghost text with it). */
// Elsewhere Tab does nothing rather than move focus off the page: an indented paragraph would turn into code.
export const indentList: Command = (view) => (inList(view.state) ? indentMore(view) : true)
export const outdentList: Command = (view) => (inList(view.state) ? indentLess(view) : true)
export { indentLess, indentMore }

/** Take every mark off the selection (or the caret's line), and turn its lines back into plain text. */
export const clearFormatting: Command = (view) => {
  const { state } = view
  view.dispatch(
    state.changeByRange((range) => {
      const lineFrom = state.doc.lineAt(range.from)
      const lineTo = state.doc.lineAt(range.to)
      const from = range.empty ? lineFrom.from : range.from
      const to = range.empty ? lineTo.to : range.to
      const text = state
        .sliceDoc(from, to)
        .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<\/?u>/g, '')
        .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
        .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
        .replace(/`([^`]+)`/g, '$1')
        .split('\n')
        .map((l, i) => (i > 0 || from === lineFrom.from ? l.replace(PREFIX, '') : l))
        .join('\n')
      return {
        changes: { from, to, insert: text },
        range: range.empty ? EditorSelection.cursor(Math.min(from + text.length, range.head)) : EditorSelection.range(from, from + text.length),
      }
    }),
  )
  view.focus()
  return true
}

/** Insert a block on its own lines after the current one, and put the caret after it (or at `caret` within it). */
function insertBlock(view: EditorView, text: string, caret?: number) {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  const empty = !line.text.trim()
  const from = empty ? line.from : line.to
  const lead = empty ? '' : '\n\n'
  const insert = lead + text + '\n'
  view.dispatch({
    changes: { from, to: empty ? line.to : from, insert },
    selection: EditorSelection.cursor(from + (caret !== undefined ? lead.length + caret : insert.length)),
    scrollIntoView: true,
  })
  view.focus()
  return true
}

export const insertDivider: Command = (view) => insertBlock(view, '---')
export const insertTable: Command = (view) => insertBlock(view, '| Column | Column |\n| --- | --- |\n|  |  |', 2)
export const insertDate: Command = (view) => {
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
  view.dispatch(view.state.replaceSelection(date))
  view.focus()
  return true
}
export const insertImage =
  (src: string, alt = ''): Command =>
  (view) => {
    view.dispatch(view.state.replaceSelection(`![${alt}](${encodeURI(src)})`))
    view.focus()
    return true
  }

// ---- What the toolbar shows as on ----------------------------------------------------------

export interface FormatState {
  block: Block
  marks: Mark[]
}

export function formatState(state: EditorState): FormatState {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  let block = blockOf(line.text)
  const marks: Mark[] = spansAt(scanLine(line.text, line.from), head).map((sp) => sp.mark)
  for (let n: SyntaxNodeRef | null = syntaxTree(state).resolveInner(head, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') block = 'code'
    if (n.name === 'InlineCode') marks.push('code')
    if (n.name === 'Link') marks.push('link')
  }
  const stored = state.field(storedMark, false)
  if (stored && stored.at === head && !marks.includes(stored.mark)) marks.push(stored.mark)
  return { block, marks }
}

// ---- Typing shortcuts, as in Notion: `[] ` makes a to-do, `* ` a bullet ------------------------

export const inputRules = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ' || from !== to) return false
  const line = view.state.doc.lineAt(from)
  const before = view.state.sliceDoc(line.from, from)
  const rules: [RegExp, string][] = [
    [/^(\s*)\[\]$/, '$1- [ ] '],
    [/^(\s*)\[x\]$/i, '$1- [x] '],
    [/^(\s*)[*+]$/, '$1- '],
  ]
  for (const [re, out] of rules) {
    if (re.test(before)) {
      const insert = before.replace(re, out)
      view.dispatch({ changes: { from: line.from, to, insert }, selection: EditorSelection.cursor(line.from + insert.length) })
      return true
    }
  }
  return false
})

/**
 * Return on an empty list item: a nested one moves out a level, and a top-level one leaves the
 * list with a blank line after it, so the next paragraph isn't read as part of the last item.
 */
export const exitList: Command = (view) => {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const m = line.text.match(/^(\s*)([-*+] \[[ xX]\]|[-*+]|\d+[.)])\s*$/)
  if (!m || sel.head !== line.to) return false
  if (m[1].length) return indentLess(view)
  view.dispatch({ changes: { from: line.from, to: line.to, insert: '\n' }, selection: { anchor: line.from + 1 }, scrollIntoView: true })
  return true
}

// ---- Keys --------------------------------------------------------------------------------

// What each remappable command does in the editor (the keys themselves are in lib/keys.ts).
const EDITOR_COMMANDS: Record<string, Command> = {
  bold: toggleMark('bold'),
  italic: toggleMark('italic'),
  underline: toggleMark('underline'),
  strike: toggleMark('strike'),
  code: toggleMark('code'),
  highlight: toggleMark('highlight'),
  link: insertLink(),
  clear: clearFormatting,
  p: setBlock('p', false),
  h1: setBlock('h1'),
  h2: setBlock('h2'),
  h3: setBlock('h3'),
  quote: setBlock('quote'),
  codeblock: setBlock('code'),
  number: setBlock('number'),
  bullet: setBlock('bullet'),
  todo: setBlock('todo'),
  task: toggleTask,
  indent: indentMore,
  outdent: indentLess,
  find: openSearchPanel,
}

/** The formatting keys as currently bound. Tab and ⇧Tab always nest list items. */
export function formatKeys() {
  return keymap.of([
    ...Object.entries(EDITOR_COMMANDS).flatMap(([id, run]) => (binding(id) ? [{ key: binding(id), run }] : [])),
    { key: 'Tab', run: indentList },
    { key: 'Shift-Tab', run: outdentList },
  ])
}

// ---- The bar over a selection (as in Notion and Medium) --------------------------------------

const BUTTONS: { label: string; name: string; id: string; run: Command; cls: string; mark?: Mark }[] = [
  { label: 'B', name: 'Bold', id: 'bold', run: toggleMark('bold'), cls: 'is-b', mark: 'bold' },
  { label: 'I', name: 'Italic', id: 'italic', run: toggleMark('italic'), cls: 'is-i', mark: 'italic' },
  { label: 'U', name: 'Underline', id: 'underline', run: toggleMark('underline'), cls: 'is-u', mark: 'underline' },
  { label: 'S', name: 'Strikethrough', id: 'strike', run: toggleMark('strike'), cls: 'is-s', mark: 'strike' },
  { label: '</>', name: 'Code', id: 'code', run: toggleMark('code'), cls: 'is-code', mark: 'code' },
  { label: 'H', name: 'Highlight', id: 'highlight', run: toggleMark('highlight'), cls: 'is-hl', mark: 'highlight' },
  { label: 'Link', name: 'Link', id: 'link', run: insertLink(), cls: 'is-link', mark: 'link' },
]

// Whether the editor has focus: a selection left behind when the writer clicks elsewhere gets no bar.
const setFocused = StateEffect.define<boolean>()
const focused = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setFocused) ? e.value : acc), v),
})
const trackFocus = EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing))

/** A small bar over a selection, unless help is showing there. */
function formatBar(state: EditorState): Tooltip | null {
  const sel = state.selection.main
  if (sel.empty || !state.field(focused, false) || state.field(helpField, false)) return null
  const on = formatState(state).marks
  return {
    pos: sel.from,
    above: true,
    arrow: false,
    create: (view) => {
      const dom = document.createElement('div')
      dom.className = 'fmt-bar'
      for (const b of BUTTONS) {
        const btn = document.createElement('button')
        btn.textContent = b.label
        btn.title = titled(b.name, b.id)
        btn.className = b.cls + (b.mark && on.includes(b.mark) ? ' is-on' : '')
        // Keep the selection: act on mousedown and don't take focus.
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault()
          b.run(view)
        })
        dom.appendChild(btn)
      }
      return { dom, offset: { x: 0, y: 6 } }
    },
  }
}

const formatBarField = StateField.define<Tooltip | null>({
  create: formatBar,
  update: (bar, tr) =>
    tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocused)) || tr.startState.field(helpField, false) !== tr.state.field(helpField, false) ? formatBar(tr.state) : bar,
  provide: (f) => showTooltip.from(f),
})

// Ahead of the Markdown package's own Return, which would leave the next paragraph inside the list.
const listKeys = Prec.highest(keymap.of([{ key: 'Enter', run: exitList }]))

export const formatting = [listKeys, storedMark, typeStored, inputRules, focused, trackFocus, formatBarField]
