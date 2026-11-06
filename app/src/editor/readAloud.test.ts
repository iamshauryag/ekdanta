import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSchema } from '@tiptap/core'
import { extensions } from './schema.ts'
import { parseMarkdown } from './markdown.ts'
import { readableSentences, startIndex } from './readAloud.ts'

const schema = getSchema(extensions())
const docOf = (md: string) => parseMarkdown(schema, md).doc
const texts = (md: string) => readableSentences(docOf(md)).map((s) => s.text)

test('reads prose sentence by sentence, across headings and lists', () => {
  assert.deepEqual(texts('# A title\n\nDr. Rao arrived. She sat.\n\n- One item. Two.\n'), ['A title', 'Dr. Rao arrived.', 'She sat.', 'One item.', 'Two.'])
})

test('skips code, template prompts and footnote text', () => {
  const md = '*Prompt: What happened first?*\n\nIt rained.\n\n```\nconst x = 1.\n```\n\n**Prompt:** Who was there?\n\nA claim.[^1]\n\n[^1]: Smith, p. 4.\n'
  assert.deepEqual(texts(md), ['It rained.', 'A claim.[^1]'])
})

test('positions cover each sentence on the page', () => {
  const doc = docOf('Hello there. General Kenobi.\n')
  const s = readableSentences(doc)
  assert.equal(doc.textBetween(s[0].from, s[0].to), 'Hello there.')
  assert.equal(doc.textBetween(s[1].from, s[1].to), 'General Kenobi.')
})

test('a selection reads only what is selected', () => {
  const doc = docOf('One two three. Four five six.\n')
  const all = readableSentences(doc)
  const part = readableSentences(doc, all[0].from + 4, all[1].from + 4)
  assert.deepEqual(
    part.map((s) => s.text),
    ['two three.', 'Four'],
  )
})

test('starts at the sentence holding the caret, or from the top past the end', () => {
  const doc = docOf('One. Two. Three.\n')
  const s = readableSentences(doc)
  assert.equal(startIndex(s, s[1].from + 1), 1)
  assert.equal(startIndex(s, 0), 0)
  assert.equal(startIndex(s, doc.content.size), 0)
})
