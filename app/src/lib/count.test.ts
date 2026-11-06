import test from 'node:test'
import assert from 'node:assert/strict'
import { countChars, countWords, formText, graphemes, plainQuotes } from './count.ts'

test('characters are counted as people see them', () => {
  assert.equal(graphemes(''), 0)
  assert.equal(graphemes('abc'), 3)
  assert.equal(graphemes('👍🏽'), 1) // skin-tone modifier
  assert.equal(graphemes('👩‍👩‍👧'), 1) // a family joined by zero-width joiners
  assert.equal(graphemes('🇮🇳'), 1) // a flag
  assert.equal(graphemes('é'), 1) // e + combining accent
  assert.equal(graphemes('नमस्ते'), 3) // Devanagari clusters
  assert.equal(graphemes('한국어'), 3)
  assert.equal(graphemes('a\nb'), 3) // a line break is a character
  assert.equal(graphemes('a\r\nb'), 3)
})

test('no spaces leaves out spaces, tabs and line breaks', () => {
  assert.equal(countChars('one two\nthree'), 13)
  assert.equal(countChars('one two\nthree', { noSpaces: true }), 11)
  assert.equal(countChars('  ', { noSpaces: true }), 0)
})

test('words are runs between spaces with a letter or a digit', () => {
  assert.equal(countWords(''), 0)
  assert.equal(countWords('Hello, world — again'), 3)
  assert.equal(countWords('  one\n\ntwo  '), 2)
})

test('form text leaves out front matter, prompts and markup, and straightens quotes', () => {
  const file =
    '---\ntitle: Why physics\ntarget: 4000 characters\n---\n\n*Prompt: Why do you want to study this course?*\n\nI **love** the “why” of [[physics-notes|physics]].\n\nIt’s a [link](https://example.com).\n'
  const text = formText(file)
  assert.equal(text, 'I love the "why" of physics.\n\nIt\'s a link (https://example.com).')
  assert.ok(!text.includes('title'))
  assert.ok(!text.includes('Prompt'))
  // What the status bar counts is exactly the copied text.
  assert.equal(countChars(text), text.length)
})

test('paragraph breaks count as the line breaks a form receives', () => {
  assert.equal(formText('One.\n\nTwo.'), 'One.\n\nTwo.')
  assert.equal(countChars(formText('One.\n\nTwo.')), 10)
  assert.equal(formText('Line one\nline two'), 'Line one\nline two')
})

test('an empty piece counts nothing', () => {
  assert.equal(formText(''), '')
  assert.equal(formText('---\ntitle: x\n---\n\n'), '')
  assert.equal(countChars(formText('')), 0)
})

test('lists and headings keep their shape as plain text', () => {
  assert.equal(formText('# Aims\n\n- one\n- two'), 'Aims\n\n- one\n- two')
})

test('quotes are straightened', () => {
  assert.equal(plainQuotes('‘a’ “b” c d'), '\'a\' "b" c d')
})
