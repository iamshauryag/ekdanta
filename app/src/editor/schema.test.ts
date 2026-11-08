import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { extensions, hintDecorations, isBlank, pasteTarget, plainTextSlice } from './schema.ts'
import { parseMarkdown, serializeMarkdown } from './markdown.ts'

const schema = getSchema(extensions())
const HINT = 'Start writing, or type / for blocks…'
const stateOf = (md: string) => EditorState.create({ schema, doc: parseMarkdown(schema, md).doc })
const hints = (state: EditorState) => hintDecorations(state, HINT)?.find() ?? []

test('the hint shows on a new, empty document', () => {
  for (const body of ['', '\n', '\n\n\n']) {
    const state = stateOf(body)
    assert.ok(isBlank(state.doc), JSON.stringify(body))
    const found = hints(state)
    assert.equal(found.length, 1)
    assert.equal(found[0].from, 0)
  }
})

test('the hint never shows once there is anything on the page', () => {
  for (const body of ['Hello', '# A heading', '---', '![x](a.png)', '- [ ] to do', '[[Some page]]']) assert.equal(hints(stateOf(body)).length, 0, body)
})

test('new empty lines below writing get no hint', () => {
  let state = stateOf('First line.')
  // Return at the end, twice: two empty paragraphs under the text.
  for (let i = 0; i < 2; i++) {
    const end = state.doc.content.size - 1
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, end)).split(end))
  }
  assert.equal(state.doc.childCount, 3)
  assert.equal(hints(state).length, 0)
})

test('empty lines with no writing at all are not a blank page either', () => {
  let state = stateOf('')
  state = state.apply(state.tr.split(1))
  assert.equal(state.doc.childCount, 2)
  assert.equal(hints(state).length, 0)
})

test('the hint comes back when everything is deleted', () => {
  let state = stateOf('Gone soon.')
  state = state.apply(state.tr.delete(1, state.doc.content.size - 1))
  assert.equal(hints(state).length, 1)
})

const pasted = (text: string) => {
  const slice = plainTextSlice(schema, text)
  const doc = schema.topNodeType.create(null, slice.content)
  return serializeMarkdown(doc)
}

test('pasted plain text: a single newline stays a line break, a blank line a new paragraph', () => {
  assert.equal(pasted('Roses are red\nViolets are blue\n\nSecond verse.'), 'Roses are red\nViolets are blue\n\nSecond verse.\n')
  assert.equal(pasted('a\r\nb\r\n\r\nc'), 'a\nb\n\nc\n')
  assert.equal(pasted('a\n\n\n\nb'), 'a\n\nb\n')
})

test('pasted plain text drops the newline a copied line ends with, and stays one open paragraph', () => {
  const slice = plainTextSlice(schema, 'just a line\n')
  assert.equal(slice.content.childCount, 1)
  assert.equal(slice.openStart, 1)
  assert.equal(slice.openEnd, 1)
  assert.equal(slice.content.firstChild!.childCount, 1)
})

test('pasted plain text is kept as written, not read as Markdown', () => {
  assert.equal(pasted('**not bold**\n# not a heading'), '\\*\\*not bold\\*\\*\n\\# not a heading\n')
})

test('pasted lines in a heading or a table cell are joined with spaces, since each is one line in the file', () => {
  const heading = plainTextSlice(schema, 'one\ntwo', [], 'heading')
  assert.equal(heading.content.childCount, 1)
  assert.equal(heading.content.firstChild!.textContent, 'one two')
  const cell = plainTextSlice(schema, 'one\ntwo\n\nthree', [], 'cell')
  assert.equal(cell.content.childCount, 1)
  assert.equal(cell.content.firstChild!.textContent, 'one two three')
})

test('pasted text knows when it lands in a heading or a table cell', () => {
  const doc = parseMarkdown(schema, '# Title\n\nText\n\n| a | b |\n| --- | --- |\n| c | d |\n').doc
  const at = (needle: string) => {
    let found = -1
    doc.descendants((n, pos) => {
      if (found < 0 && n.isText && n.text === needle) found = pos + 1
    })
    return doc.resolve(found)
  }
  assert.equal(pasteTarget(at('Title')), 'heading')
  assert.equal(pasteTarget(at('Text')), 'text')
  assert.equal(pasteTarget(at('c')), 'cell')
  assert.equal(pasteTarget(at('a')), 'cell')
})
