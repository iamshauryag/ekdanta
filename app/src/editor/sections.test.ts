import test from 'node:test'
import assert from 'node:assert/strict'
import { Schema, type Node as PMNode } from '@tiptap/pm/model'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import { closeHistory, history, undo } from '@tiptap/pm/history'
import { blocksOfDoc, bodyEnd, canMove, moveBlocks, movedIndex, opening, paragraphStep, reorder, rowsOf, sectionEnd, sectionStep, type Block } from './sections.ts'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    blockquote: { group: 'block', content: 'block+' },
    text: { group: 'inline' },
  },
  marks: { italic: {}, bold: {} },
})

const p = (t: string) => schema.node('paragraph', null, t ? [schema.text(t)] : [])
const h = (level: number, t: string) => schema.node('heading', { level }, [schema.text(t)])
const doc = (...nodes: PMNode[]) => schema.node('doc', null, nodes)
const texts = (d: PMNode) => {
  const out: string[] = []
  d.forEach((n) => out.push(n.textContent))
  return out
}

// # A, a1, ## A.1, a1x, ## A.2, # B, b1, # C, c1
const B = (s: string): Block[] =>
  s
    .split(' ')
    .map((t) =>
      t.startsWith('h')
        ? { kind: 'heading', level: Number(t[1]), text: t }
        : t === 'fn'
          ? { kind: 'footnote', level: 0, text: '[^1]: x' }
          : t === '_'
            ? { kind: 'empty', level: 0, text: '' }
            : { kind: 'paragraph', level: 0, text: t },
    )

test('a section runs to the next heading of the same or a higher level', () => {
  const b = B('h1 a h2 b h3 c h2 d h1 e')
  assert.equal(sectionEnd(b, 0), 8) // the H1 takes its H2s and H3 with it
  assert.equal(sectionEnd(b, 2), 6) // the first H2 takes its H3
  assert.equal(sectionEnd(b, 4), 6)
  assert.equal(sectionEnd(b, 6), 8)
  assert.equal(sectionEnd(b, 8), 10)
})

test('a section cannot be dropped into itself or its own subsections', () => {
  const b = B('h1 a h2 b h3 c h2 d h1 e')
  assert.equal(canMove(b, 0, 8, 2), false)
  assert.equal(canMove(b, 0, 8, 4), false)
  assert.equal(canMove(b, 0, 8, 8), false) // where it already is
  assert.equal(canMove(b, 0, 8, 0), false)
  assert.equal(canMove(b, 0, 8, 10), true)
  assert.equal(canMove(b, 8, 10, 0), true)
})

test('reorder moves a run before a target, either way', () => {
  const x = ['p', 'A', 'a', 'B', 'b', 'C', 'c']
  assert.deepEqual(reorder(x, 5, 7, 1), ['p', 'C', 'c', 'A', 'a', 'B', 'b'])
  assert.deepEqual(reorder(x, 1, 3, 7), ['p', 'B', 'b', 'C', 'c', 'A', 'a'])
  assert.deepEqual(reorder(x, 1, 3, 5), ['p', 'B', 'b', 'A', 'a', 'C', 'c'])
  assert.equal(movedIndex(1, 3, 5), 3)
  assert.equal(movedIndex(5, 7, 1), 1)
})

test('⌥↑ / ⌥↓ move among siblings, not out of the parent', () => {
  const b = B('pre h2 a h3 x h3 y h2 b h2 c')
  // the second H2 (index 7) goes before the first (index 1)
  assert.equal(sectionStep(b, 7, -1), 1)
  // the first H2 has nothing above it at its level: the preamble stays put
  assert.equal(sectionStep(b, 1, -1), null)
  // the first H2 goes after the second, i.e. before the third
  assert.equal(sectionStep(b, 1, 1), 9)
  // the last H2 can't go further down
  assert.equal(sectionStep(b, 9, 1), null)
  // the first H3 is the first under its H2; the second H3 can't leave its H2 downwards
  assert.equal(sectionStep(b, 3, -1), null)
  assert.equal(sectionStep(b, 5, 1), null)
  assert.equal(sectionStep(b, 5, -1), 3)
})

test('footnote definitions at the end stay at the end', () => {
  const b = B('h2 a h2 b _ fn fn _')
  assert.equal(bodyEnd(b), 5) // the blank line before the notes belongs to the body
  assert.equal(sectionEnd(b, 2), 5) // the last section stops before the notes
  assert.equal(canMove(b, 0, 2, 6), false) // nothing can go among the notes
  assert.equal(sectionStep(b, 0, 1), 5)
  assert.equal(bodyEnd(B('h2 a _')), 3) // no notes: blank lines are just body
})

test('moving the third H2 above the first keeps the preamble on top, and one undo restores it', () => {
  const d = doc(p('Preamble.'), h(2, 'One'), p('one'), h(3, 'One.a'), p('one a'), h(2, 'Two'), p('two'), h(2, 'Three'), p('three [^1]'), p('[^1]: The note.'))
  let state = EditorState.create({ doc: d, plugins: [history()] })
  const blocks = blocksOfDoc(state.doc)
  assert.equal(blocks[9].kind, 'footnote')
  assert.equal(sectionEnd(blocks, 7), 9)
  const tr = moveBlocks(state, 7, sectionEnd(blocks, 7), 1)!
  assert.ok(tr)
  state = state.apply(tr)
  assert.deepEqual(texts(state.doc), ['Preamble.', 'Three', 'three [^1]', 'One', 'one', 'One.a', 'one a', 'Two', 'two', '[^1]: The note.'])
  // Blocks are moved, not rebuilt, so the file writes them back as they were.
  assert.equal(state.doc.child(1), d.child(7))
  assert.equal(state.doc.child(3), d.child(1))
  undo(state, (t) => (state = state.apply(t)))
  assert.ok(state.doc.eq(d))
})

test('moving into its own subsection changes nothing', () => {
  const d = doc(h(1, 'A'), p('a'), h(2, 'A.1'), p('b'), h(1, 'B'))
  const state = EditorState.create({ doc: d })
  assert.equal(moveBlocks(state, 0, 4, 2), null)
  assert.equal(moveBlocks(state, 0, 4, 4), null)
})

test('rows skip prompts, blank lines and notes, and mark quotations', () => {
  const prompt = schema.node('paragraph', null, [schema.text('Prompt: What happened first?', [schema.marks.italic.create()])])
  const labelled = schema.node('paragraph', null, [schema.text('Prompt:', [schema.marks.bold.create()]), schema.text(' Under 1,300 characters')])
  const quote = schema.node('blockquote', null, [p('Words of someone else.')])
  const d = doc(h(2, 'Intro'), prompt, labelled, p(''), p('My own first paragraph here.'), quote, p('[^2]: A note mid-way.'), p('Last.'), p('[^1]: End note.'))
  const rows = rowsOf(blocksOfDoc(d))
  assert.deepEqual(
    rows.map((r) => [r.index, r.kind]),
    [
      [0, 'heading'],
      [4, 'paragraph'],
      [5, 'quote'],
      [7, 'paragraph'],
    ],
  )
  // A paragraph moves past the row above or below, a heading included.
  assert.equal(paragraphStep(rows, 4, -1), 0)
  assert.equal(paragraphStep(rows, 4, 1), 6)
  assert.equal(paragraphStep(rows, 7, 1), null)
  assert.equal(paragraphStep(rows, 0, -1), null)
})

test('a paragraph moves alone', () => {
  const d = doc(h(2, 'A'), p('first'), p('second'), h(2, 'B'), p('third'))
  let state = EditorState.create({ doc: d, plugins: [history()] })
  state = state.apply(moveBlocks(state, 4, 5, 1)!)
  assert.deepEqual(texts(state.doc), ['A', 'third', 'first', 'second', 'B'])
})

test('opening shows the first words', () => {
  assert.equal(opening('One two three four five six seven eight nine ten'), 'One two three four five six seven eight…')
  assert.equal(opening('  Short   one. '), 'Short one.')
})

test("typing straight after a move does not join the move's undo step", () => {
  const d = doc(h(2, 'One'), p('one'), h(2, 'Two'), p('two'))
  let state = EditorState.create({ doc: d, plugins: [history()] })
  const dispatch = (t: Transaction) => (state = state.apply(t))
  const blocks = blocksOfDoc(state.doc)
  // What the Outline does: the move, then history closed on both sides of it.
  dispatch(closeHistory(moveBlocks(state, 2, sectionEnd(blocks, 2), 0)!))
  dispatch(closeHistory(state.tr))
  const moved = texts(state.doc)
  assert.deepEqual(moved, ['Two', 'two', 'One', 'one'])
  dispatch(state.tr.insertText('!', 1)) // within the half-second that history groups changes
  undo(state, dispatch)
  assert.deepEqual(texts(state.doc), moved) // only the typing went back
  undo(state, dispatch)
  assert.ok(state.doc.eq(d))
})
