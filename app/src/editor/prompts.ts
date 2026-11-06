// A template's writing prompts on the page: paragraphs that are only `*Prompt: …*`. They are guidance,
// not the writer's words, so they're drawn faded, left out of the word count, and a click selects the
// whole prompt so that typing replaces it with plain text. Also here: putting a template's text into
// the page, with the caret where its {{cursor}} was.
import type { Editor } from '@tiptap/core'
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { isPromptParagraph } from '../lib/special.ts'
import { parseMarkdown, serializeMarkdown } from './markdown.ts'

/** Is this paragraph a prompt? The same rule Recall and voice use, applied to its Markdown. */
export function isPromptNode(node: PMNode): boolean {
  if (node.type.name !== 'paragraph' || !/^\s*Prompt:/i.test(node.textContent)) return false
  return isPromptParagraph(serializeMarkdown(node.type.schema.topNodeType.create(null, node)))
}

/** Every prompt's text, as document positions (the inside of each paragraph). */
export function promptRanges(doc: PMNode): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') {
      if (isPromptNode(node)) out.push({ from: pos + 1, to: pos + node.nodeSize - 1 })
      return false
    }
    return node.isBlock
  })
  return out
}

const key = new PluginKey<DecorationSet>('prompts')

/** A template's {{title}} still waiting for the piece's title: drawn as a placeholder. */
function titlePlaceholders(doc: PMNode) {
  const out: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    for (const m of node.text!.matchAll(/\{\{\s*title\s*\}\}/gi))
      out.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, { class: 'is-placeholder', title: 'Filled in with the title when you give the piece one' }))
    return false
  })
  return out
}

const decorate = (doc: PMNode) =>
  DecorationSet.create(doc, [
    ...promptRanges(doc).map((r) => Decoration.node(r.from - 1, r.to + 1, { class: 'is-prompt', title: 'A prompt from the template: click it and type to replace it' })),
    ...titlePlaceholders(doc),
  ])

/** Is the selection exactly one whole prompt (as a click or a template's {{cursor}} leaves it)? */
export function isPromptSelected(state: EditorState) {
  const { from, to, empty } = state.selection
  if (empty) return false
  const r = promptAt(state, from)
  return !!r && r.from === from && r.to === to
}

/** The prompt the position is in, if any. */
function promptAt(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.type.name === 'paragraph') return isPromptNode(node) ? { from: $pos.start(d), to: $pos.end(d) } : null
  }
  return null
}

/** The prompt that holds all of from..to, if any. */
function promptAround(state: EditorState, from: number, to: number) {
  const r = promptAt(state, from)
  return r && to >= r.from && to <= r.to ? r : null
}

/** Select a whole prompt, so the next keystroke replaces it. */
export function selectPrompt(view: EditorView, pos: number) {
  const r = promptAt(view.state, pos)
  if (!r) return false
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, r.from, r.to)))
  return true
}

export function promptPlugin() {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_c, state) => decorate(state.doc),
      apply: (tr, set) => (tr.docChanged ? decorate(tr.doc) : set),
    },
    props: {
      decorations: (state) => key.getState(state),
      handleClick: (view, pos, e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.detail > 1) return false
        return selectPrompt(view, pos)
      },
      // A prompt is a placeholder, not text to edit: typing anywhere in it (a click selects it all, but
      // arrow keys can put the caret inside) replaces the whole prompt with plain text, so the writer's
      // words never end up inside a prompt, uncounted and hidden from Recall.
      handleTextInput: (view, from, to, text) => {
        const r = promptAround(view.state, from, to)
        if (!r || view.composing) return false
        const tr = view.state.tr.replaceWith(r.from, r.to, view.state.schema.text(text)).setStoredMarks([])
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, r.from + text.length)).scrollIntoView())
        return true
      },
      // Pasting into a prompt replaces it, as typing does.
      handlePaste: (view) => {
        const { from, to } = view.state.selection
        const r = promptAround(view.state, from, to)
        if (r && (from !== r.from || to !== r.to)) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, r.from, r.to)))
        return false
      },
      handleKeyDown: (view, e) => {
        if (e.metaKey || e.ctrlKey || e.altKey || view.composing) return false
        const { from, to, empty } = view.state.selection
        const r = promptAround(view.state, from, to)
        if (!r) return false
        // Return in a prompt starts a new line after it (before it, at its very start) and leaves it whole.
        if (e.key === 'Enter' && !e.shiftKey) {
          const before = empty && from === r.from && r.from !== r.to
          const at = before ? r.from - 1 : r.to + 1
          const tr = view.state.tr.insert(at, view.state.schema.nodes.paragraph.create())
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView())
          return true
        }
        // Backspace or Delete inside a prompt clears all of it; at its edges they join lines as usual.
        if ((e.key === 'Backspace' || e.key === 'Delete') && !(empty && from === (e.key === 'Backspace' ? r.from : r.to))) {
          const tr = view.state.tr.delete(r.from, r.to).setStoredMarks([])
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, r.from)).scrollIntoView())
          return true
        }
        return false
      },
    },
  })
}

/**
 * Where the caret goes for a template's {{cursor}}: `markdown` was parsed into the blocks that start at
 * `start` in `doc`, and `cursor` is an offset into it. The caret goes to the same place in the same
 * block, or to the start of the block that follows when {{cursor}} began a line. A prompt there is selected.
 */
export function caretFor(schema: Schema, doc: PMNode, start: number, markdown: string, cursor: number): { from: number; to: number } {
  const prefix = markdown.slice(0, cursor)
  const before = parseMarkdown(schema, prefix).doc
  // Nothing written before it (an empty document still holds one empty paragraph): the first block.
  const count = prefix.trim() ? before.childCount : 0
  const atLineStart = cursor === 0 || markdown[cursor - 1] === '\n'
  const index = atLineStart ? count : Math.max(0, count - 1)
  let pos = start
  const $start = doc.resolve(start)
  const parent = $start.parent
  for (let i = $start.index(), n = 0; i < parent.childCount && n < index; i++, n++) pos += parent.child(i).nodeSize
  pos = Math.min(pos, doc.content.size)
  const block = doc.nodeAt(pos)
  let at = pos + 1
  if (block?.isTextblock && !atLineStart) at = pos + 1 + Math.min(block.content.size, before.lastChild?.textContent.length ?? 0)
  const sel = TextSelection.near(doc.resolve(Math.min(at, doc.content.size)))
  const $h = sel.$head
  if ($h.parent.type.name === 'paragraph' && isPromptNode($h.parent)) return { from: $h.start(), to: $h.end() }
  return { from: sel.from, to: sel.to }
}

/**
 * Put a template's text into the page where the caret is: in place of the line it's on when that line
 * is empty, otherwise after the block the caret is in. The caret goes to {{cursor}}, if it had one.
 */
export function insertTemplate(editor: Editor, markdown: string, cursor: number | null) {
  const { state } = editor
  const blocks = parseMarkdown(state.schema, markdown).doc.content
  if (!blocks.size) return
  const $from = state.selection.$from
  const top = $from.depth > 0 ? $from.before(1) : 0
  const topNode = state.doc.nodeAt(top)
  const empty = topNode?.type.name === 'paragraph' && !topNode.content.size
  const at = !topNode ? state.doc.content.size : empty ? top : top + topNode.nodeSize
  const tr = state.tr.replaceWith(at, empty ? at + topNode!.nodeSize : at, blocks)
  const sel =
    cursor === null
      ? TextSelection.near(tr.doc.resolve(Math.min(at + blocks.size, tr.doc.content.size)), -1)
      : (() => {
          const c = caretFor(state.schema, tr.doc, at, markdown, cursor)
          return TextSelection.create(tr.doc, c.from, c.to)
        })()
  editor.view.dispatch(tr.setSelection(sel).scrollIntoView())
  editor.view.focus()
}

/** Replace a template's placeholder (say {{title}}) wherever it's still on the page. */
export function replacePlaceholder(editor: Editor, placeholder: string, value: string) {
  const { state } = editor
  const hits: number[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isText) return true
    for (let i = node.text!.indexOf(placeholder); i >= 0; i = node.text!.indexOf(placeholder, i + placeholder.length)) hits.push(pos + i)
    return false
  })
  if (!hits.length) return false
  const tr = state.tr
  for (const pos of hits.reverse()) tr.insertText(value, pos, pos + placeholder.length)
  editor.view.dispatch(tr)
  return true
}
