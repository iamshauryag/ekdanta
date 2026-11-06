// Read aloud, on the page: which sentences there are to read (with their document positions), and
// the soft highlight on the one being read. The speaking itself is lib/speak.ts.
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { isSpeakable, splitSentences } from '../lib/sentences.ts'
import { isPromptParagraph } from '../lib/special.ts'
import type { Sentence } from '../lib/speak.ts'
import { leafText } from './help.ts'

/** Blocks that are not prose to listen to: code, and Markdown kept as written. */
const SKIP_BLOCKS = new Set(['codeBlock', 'rawBlock'])

/** A textblock as Markdown-ish text, just enough to tell a template's `*Prompt: …*` line from prose. */
function promptForm(block: PMNode): string {
  const texts: { text: string; em: boolean; strong: boolean }[] = []
  block.forEach((n) => {
    if (n.isText) texts.push({ text: n.text!, em: n.marks.some((m) => m.type.name === 'italic'), strong: n.marks.some((m) => m.type.name === 'bold') })
  })
  const all = texts.map((t) => t.text).join('')
  if (!/^\s*Prompt:/i.test(all)) return all
  if (texts.every((t) => t.em || !t.text.trim())) return `*${all.trim()}*`
  if (texts.every((t) => t.strong || !t.text.trim())) return `**${all.trim()}**`
  // "**Prompt:** what to write here": the label alone is bold.
  if (texts[0].strong && /^\s*Prompt:\s*$/i.test(texts[0].text)) return `**Prompt:** ${all.slice(texts[0].text.length).trim()}`
  return all
}

/** A footnote's own text ("[^1]: Smith, p. 4.") is read where it is cited, not in the flow. */
const isFootnoteDefinition = (text: string) => /^\s*\[\^[^\]]+\]:/.test(text)

/**
 * Every sentence there is to read between two positions (the whole document by default), in
 * order. Code, a template's prompts and footnote text are left out; the front matter is never in
 * the editor. A sentence only partly inside the range is cut to it.
 */
export function readableSentences(doc: PMNode, from = 0, to = doc.content.size): Sentence[] {
  const out: Sentence[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (SKIP_BLOCKS.has(node.type.name)) return false
    if (!node.isTextblock) return true
    // The block's text, with the document position of every character.
    let text = ''
    const at: number[] = []
    node.forEach((child, offset) => {
      const p = pos + 1 + offset
      if (child.isText) {
        for (let k = 0; k < child.text!.length; k++) at.push(p + k)
        text += child.text
      } else {
        const t = leafText(child)
        for (let k = 0; k < t.length; k++) at.push(p)
        text += t
      }
    })
    if (!text.trim() || isPromptParagraph(promptForm(node)) || isFootnoteDefinition(text)) return false
    for (const s of splitSentences(text)) {
      const start = at[s.from]
      const end = at[s.to - 1] + 1
      if (end <= from || start >= to) continue
      // Cut to the range by characters, so a selection's partial sentence reads only what is selected.
      let i = s.from
      while (i < s.to && at[i] < from) i++
      let j = s.to
      while (j > i && at[j - 1] >= to) j--
      const said = text.slice(i, j).trim()
      if (said && isSpeakable(said)) out.push({ text: said, from: Math.max(start, from), to: Math.min(end, to) })
    }
    return false
  })
  return out
}

/** Where reading starts for a caret: the sentence it is in, or the first one after it; from the top when the caret is past the last. */
export function startIndex(sentences: Sentence[], caret: number): number {
  const i = sentences.findIndex((s) => s.to > caret)
  return i === -1 ? 0 : i
}

// ---- The highlight ------------------------------------------------------------------------------

export const readKey = new PluginKey<DecorationSet>('readAloud')

/** Show the highlight on a range, or remove it (null). */
export const setReading = (tr: Transaction, range: { from: number; to: number } | null) => tr.setMeta(readKey, range).setMeta('addToHistory', false)

export const readingDecorations = (state: EditorState) => readKey.getState(state)

export const readAloudPlugin = () =>
  new Plugin<DecorationSet>({
    key: readKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set, _old, state) {
        const range = tr.getMeta(readKey) as { from: number; to: number } | null | undefined
        if (range === undefined) return set.map(tr.mapping, tr.doc)
        if (!range) return DecorationSet.empty
        const decos = [Decoration.inline(range.from, range.to, { class: 'read-now' })]
        // The top-level block stays lit in Focus mode, wherever the caret is.
        const $at = state.doc.resolve(range.from)
        if ($at.depth >= 1) {
          const start = $at.before(1)
          decos.push(Decoration.node(start, start + $at.node(1).nodeSize, { class: 'is-reading' }))
        }
        return DecorationSet.create(state.doc, decos)
      },
    },
    props: {
      decorations: (state) => readKey.getState(state),
    },
  })
