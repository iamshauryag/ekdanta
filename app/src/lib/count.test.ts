import test from 'node:test'
import assert from 'node:assert/strict'
import { countChars, countWords, countedWords, formText, graphemes, plainQuotes } from './count.ts'

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

test('a word limit leaves out a Works Cited section, up to the next heading of its level', () => {
  const file = '---\ntarget: 1500\n---\n\n# On walls\n\nOne two three four.\n\n## Works Cited\n\nSmith, Jane. *Walls*. 2020.\n\n- Doe, John. Fences.\n\n## Appendix\n\nFive six.\n'
  const all = countWords(formText(file))
  const { words, excluded } = countedWords(file)
  assert.deepEqual(excluded, [{ heading: 'Works Cited', words: 9 }])
  assert.equal(words, all - 9)
  assert.equal(words, 9) // On walls, the four words, Appendix, five six
  // A higher heading ends the section too, and a setext heading or a heading in bold is still found.
  assert.equal(countedWords('Text here.\n\nReferences\n----------\n\nA source.\n\n# Next part\n\nMore.\n').words, 5)
  assert.equal(countedWords('Text.\n\n## **Bibliography:**\n\nA B C\n').excluded[0].heading, 'Bibliography:')
  // Nothing to leave out: the same count as the form's text, and a heading that only mentions references stays.
  assert.deepEqual(countedWords('# References to the sea\n\nWaves.\n'), { words: 5, excluded: [] })
  assert.deepEqual(countedWords('Plain words only.'), { words: 3, excluded: [] })
})
