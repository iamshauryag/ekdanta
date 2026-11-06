import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_KINDS, cleanKinds, kindOfFolder, newKind } from './kinds.ts'

test('cleanKinds keeps template and doc fields that are well formed', () => {
  const [k] = cleanKinds([
    { id: 'paper', name: 'Paper', folder: 'papers', guidance: '', words: 2000, template: 'templates/paper.md', doc: { layout: 'page', style: 'apa', paper: 'a4', target: '1500-2000' } },
  ])!
  assert.equal(k.template, 'templates/paper.md')
  assert.deepEqual(k.doc, { layout: 'page', style: 'apa', paper: 'a4', target: '1500-2000' })
})

test('a bad doc field is dropped and the kind is kept', () => {
  const out = cleanKinds([{ id: 'essay', name: 'Essay', folder: 'essays', guidance: '', words: 1200, doc: { style: 'harvard', paper: 'a4', layout: 'scroll', target: 7 } }])!
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].doc, { paper: 'a4' })
  const none = cleanKinds([{ id: 'essay', name: 'Essay', doc: { style: 'harvard' } }])!
  assert.equal('doc' in none[0], false)
  assert.equal('doc' in cleanKinds([{ id: 'essay', doc: 'mla' }])![0], false)
})

test('a template outside the vault or not Markdown is dropped', () => {
  for (const template of ['../secrets.md', '/etc/passwd.md', 'templates/x.txt', 'templates//x.md', 'C:/x.md', '', 5]) {
    const [k] = cleanKinds([{ id: 'essay', template }])!
    assert.equal('template' in k, false, String(template))
  }
})

test('kinds without the new fields come out exactly as before', () => {
  assert.deepEqual(cleanKinds(DEFAULT_KINDS), DEFAULT_KINDS)
})

test('special folders hold no kind', () => {
  const kinds = [...DEFAULT_KINDS, { id: 'journal', name: 'Journal', folder: 'journal', guidance: '', words: 300 }]
  assert.equal(kindOfFolder(kinds, 'journal'), undefined)
  assert.equal(kindOfFolder(kinds, 'templates'), undefined)
  assert.equal(kindOfFolder(kinds, 'essays')?.id, 'essay')
})

test('a kind never files into a special folder', () => {
  assert.equal(newKind('Template', DEFAULT_KINDS)?.folder, 'my-templates')
  assert.equal(newKind('Journal', DEFAULT_KINDS)?.folder, 'journals') // not the special journal/
  assert.equal(newKind('Source', DEFAULT_KINDS)?.folder, 'my-sources')
  assert.equal(newKind('Export', DEFAULT_KINDS)?.folder, 'my-exports')
  const [kind] = cleanKinds([{ id: 'journal', name: 'Journal', folder: 'journal', guidance: '', words: 300 }])!
  assert.equal(kind.folder, 'my-journal')
  assert.equal(kindOfFolder([kind], 'my-journal')?.id, 'journal')
  assert.equal(kindOfFolder([kind], 'journal'), undefined)
})
