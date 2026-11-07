import test from 'node:test'
import assert from 'node:assert/strict'
import { docSlug, sameName, slug } from './slug.ts'

test('Latin titles keep the names they always had', () => {
  assert.equal(slug('Café notes', 60), 'cafe-notes')
  assert.equal(slug('On Being Edited', 60), 'on-being-edited')
  assert.equal(slug("The writer's notes", 60), 'the-writers-notes')
  assert.equal(slug('Crème brûlée, 2nd try!', 60), 'creme-brulee-2nd-try')
  assert.equal(slug('Café notes'.normalize('NFD'), 60), 'cafe-notes')
})

test('other scripts keep their letters and marks', () => {
  assert.equal(slug('मेरा निबंध', 60), 'मेरा-निबंध')
  assert.equal(slug('日記 2026', 60), '日記-2026')
  assert.equal(slug('한국어 노트', 60), '한국어-노트')
  // Hangul stays composed even when typed decomposed.
  assert.equal(slug('한국어'.normalize('NFD'), 60), '한국어')
  // A Devanagari nukta form keeps its nukta (as NFC spells it).
  assert.equal(slug('ज़िंदगी', 60), 'ज़िंदगी'.normalize('NFC'))
  assert.equal(slug('Привет мир', 60), 'привет-мир')
})

test('characters files refuse are removed', () => {
  assert.equal(slug('Notes: a/b\\c*d?e"f<g>h|i', 60), 'notes-a-b-c-d-e-f-g-h-i')
  assert.equal(slug('tab\there\u0001', 60), 'tab-here')
})

test('an empty slug falls back to a dated note', () => {
  assert.equal(slug('🎉🎉', 60), '')
  assert.equal(docSlug('🎉🎉', '2026-11-06'), 'note-2026-11-06')
  assert.equal(docSlug('', '2026-11-06'), 'note-2026-11-06')
  assert.equal(docSlug('Hello', '2026-11-06'), 'hello')
})

test('slugs are cut by characters, never mid-character, with no trailing hyphen', () => {
  assert.equal(slug('a'.repeat(39) + ' b', 40), 'a'.repeat(39))
  const emojiless = slug('𠀀'.repeat(50), 40)
  assert.equal(Array.from(emojiless).length, 40)
  assert.ok(!/[\uD800-\uDBFF]$/.test(emojiless))
})

test('NFD and NFC names are the same name', () => {
  assert.equal(sameName('café'.normalize('NFD'), 'café'), true)
  assert.equal(sameName('cafe', 'café'), false)
})
