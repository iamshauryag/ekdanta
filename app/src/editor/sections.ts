// Sections and paragraphs as units that can be moved, for the Outline tab. A section is a heading and
// everything under it, up to the next heading of the same or a higher level. All of this works on the
// document's top-level blocks: a move takes a run of them out and puts it back elsewhere, as one
// ProseMirror step, so ⌘Z puts everything back in one go and untouched blocks keep their identity (and
// so are written back to the file exactly as they were; see markdown.ts).
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'

export type BlockKind = 'heading' | 'paragraph' | 'quote' | 'footnote' | 'prompt' | 'empty' | 'other'

/** A top-level block, as the outline sees it. */
export interface Block {
  kind: BlockKind
  /** 1–6 for a heading, 0 for everything else. */
  level: number
  text: string
}

/** A row in the Outline: a top-level block (by index) the writer can see, jump to and move. */
export interface Row {
  index: number
  kind: 'heading' | 'paragraph' | 'quote'
  level: number
  text: string
  words: number
}

const FOOTNOTE_DEF = /^\[\^[^\]\s]+\]:/

/** A paragraph that is only a template's writing prompt (`*Prompt: …*`, or `**Prompt:** …` on one line). */
export function isPromptNode(node: PMNode): boolean {
  if (node.type.name !== 'paragraph' || !/^prompt:/i.test(node.textContent.trim())) return false
  const runs: PMNode[] = []
  node.forEach((c) => runs.push(c))
  const emph = (c: PMNode) => c.isText && c.marks.some((m) => m.type.name === 'italic' || m.type.name === 'bold')
  if (!runs.length || !emph(runs[0])) return false
  if (runs.every((c) => emph(c) || (c.isText && !c.text!.trim()))) return true
  return /^prompt:\s*$/i.test(runs[0].text!.trim()) && !runs.some((c) => c.type.name === 'hardBreak')
}

/** What a top-level node is, for moving. */
export function blockOf(node: PMNode): Block {
  const text = node.textContent.replace(/\s+/g, ' ').trim()
  const name = node.type.name
  if (name === 'heading') return { kind: 'heading', level: node.attrs.level, text }
  // footnoteDef is the footnotes feature's node; until then a definition is a paragraph `[^1]: …`.
  if (name === 'footnoteDef' || (name === 'paragraph' && FOOTNOTE_DEF.test(text))) return { kind: 'footnote', level: 0, text }
  if (name === 'paragraph') return { kind: !text ? 'empty' : isPromptNode(node) ? 'prompt' : 'paragraph', level: 0, text }
  if (name === 'blockquote') return { kind: text ? 'quote' : 'empty', level: 0, text }
  return { kind: 'other', level: 0, text }
}

export function blocksOfDoc(doc: PMNode): Block[] {
  const out: Block[] = []
  doc.forEach((n) => out.push(blockOf(n)))
  return out
}

/**
 * Where the movable body ends: footnote definitions at the end of the document (and blank lines among
 * them) stay there, so the references in a moved section still find them and the notes stay last.
 */
export function bodyEnd(blocks: Block[]): number {
  let i = blocks.length
  let notes = false
  while (i > 0 && (blocks[i - 1].kind === 'footnote' || blocks[i - 1].kind === 'empty')) {
    if (blocks[i - 1].kind === 'footnote') notes = true
    i--
  }
  if (!notes) return blocks.length
  // Blank lines before the first note belong to the body, not the notes.
  while (i < blocks.length && blocks[i].kind === 'empty') i++
  return i
}

/** The end (exclusive) of the section that starts with the heading at `i`. */
export function sectionEnd(blocks: Block[], i: number): number {
  const end = bodyEnd(blocks)
  const level = blocks[i].level
  for (let j = i + 1; j < end; j++) if (blocks[j].kind === 'heading' && blocks[j].level <= level) return j
  return Math.max(end, i + 1)
}

/** Whether the run [start, end) can go before block `target` (an index in the same list) and change anything. */
export function canMove(blocks: Block[], start: number, end: number, target: number): boolean {
  if (start < 0 || end <= start || end > blocks.length) return false
  if (target < 0 || target > bodyEnd(blocks)) return false
  // Into itself (a section into its own subsection), or back where it already is.
  return target < start || target > end
}

/** `items` with the run [start, end) taken out and put back before `target` (an index in the original). */
export function reorder<T>(items: T[], start: number, end: number, target: number): T[] {
  const run = items.slice(start, end)
  const rest = [...items.slice(0, start), ...items.slice(end)]
  const at = target > start ? target - (end - start) : target
  return [...rest.slice(0, at), ...run, ...rest.slice(at)]
}

/** Where a section can move with ⌥↑ / ⌥↓: before its previous sibling, or after its next one. */
export function sectionStep(blocks: Block[], i: number, dir: -1 | 1): number | null {
  const level = blocks[i].level
  if (dir < 0) {
    for (let k = i - 1; k >= 0; k--) {
      if (blocks[k].kind !== 'heading' || blocks[k].level > level) continue
      return blocks[k].level === level ? k : null // its parent: already the first under it
    }
    return null
  }
  const next = sectionEnd(blocks, i)
  if (next >= bodyEnd(blocks) || blocks[next].level < level) return null
  return sectionEnd(blocks, next)
}

/** The Outline's rows: every top-level heading, and every paragraph and quotation of the writer's own. */
export function rowsOf(blocks: Block[]): Row[] {
  const end = bodyEnd(blocks)
  const rows: Row[] = []
  for (let i = 0; i < end; i++) {
    const b = blocks[i]
    if (b.kind !== 'heading' && b.kind !== 'paragraph' && b.kind !== 'quote') continue
    rows.push({ index: i, kind: b.kind, level: b.level, text: b.text, words: b.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length })
  }
  return rows
}

/**
 * Where a paragraph moves with ⌥↑ / ⌥↓ in the Paragraphs view: past the row above or below it, a
 * heading included (so it can change sections). Returns a block index to put it before.
 */
export function paragraphStep(rows: Row[], at: number, dir: -1 | 1): number | null {
  const k = rows.findIndex((r) => r.index === at)
  if (k < 0) return null
  if (dir < 0) return k > 0 ? rows[k - 1].index : null
  return k < rows.length - 1 ? rows[k + 1].index + 1 : null
}

/** The first words of a paragraph, for its row. */
export function opening(text: string, words = 8): string {
  const all = text.split(/\s+/).filter(Boolean)
  return all.length > words ? all.slice(0, words).join(' ') + '…' : all.join(' ')
}

/** A paragraph that is a quotation: a block quote, or a paragraph that is all one quoted passage. */
export function isQuote(row: Row): boolean {
  return row.kind === 'quote' || /^["“«].*["”»]$/su.test(row.text)
}

export const SHORT_WORDS = 15

/** The position where top-level block `index` starts. */
export function posOf(doc: PMNode, index: number): number {
  let pos = 0
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize
  return pos
}

/**
 * Move the top-level blocks [start, end) to before block `target`, as one step that only touches the
 * region between them. Null if that would change nothing or isn't allowed.
 */
export function moveBlocks(state: EditorState, start: number, end: number, target: number): Transaction | null {
  const doc = state.doc
  if (!canMove(blocksOfDoc(doc), start, end, target)) return null
  const lo = Math.min(start, target)
  const hi = Math.max(end, target)
  const nodes: PMNode[] = []
  for (let i = lo; i < hi; i++) nodes.push(doc.child(i))
  const moved = reorder(nodes, start - lo, end - lo, target - lo)
  return state.tr.replaceWith(posOf(doc, lo), posOf(doc, hi), Fragment.from(moved))
}

/** Where the moved run's first block now starts, after moveBlocks(…, start, end, target). */
export function movedIndex(start: number, end: number, target: number): number {
  return target > start ? target - (end - start) : target
}
