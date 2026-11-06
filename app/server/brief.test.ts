// Pinned briefs against a scratch vault: stored beside the document, never in it, and following it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-brief-'))
process.env.EKDANTA_VAULT = root
const vault = await import('./vault.ts')
const { readBrief, writeBrief, briefFile, briefForPrompt } = await import('./brief.ts')
const exists = (abs: string) =>
  fs.access(abs).then(
    () => true,
    () => false,
  )

test.after(() => fs.rm(root, { recursive: true, force: true }))

const DOC = '---\ntitle: Cities\nplatform: essay\n---\n\nCities are loud.\n'

test('pinning stores the brief beside the document and leaves the document byte-identical', async () => {
  await vault.writeDoc('essays/cities.md', DOC)
  const before = await fs.readFile(path.join(root, 'essays/cities.md'))
  const saved = await writeBrief('essays/cities.md', '  Evaluate the claim that cities make people lonelier.\r\n\r\n')
  assert.equal(saved, 'Evaluate the claim that cities make people lonelier.')
  assert.equal(await readBrief('essays/cities.md'), saved + '\n')
  assert.equal(path.basename(briefFile('essays/cities.md')), 'essays__cities.brief.md')
  assert.ok(briefFile('essays/cities.md').startsWith(path.join(root, '.ekdanta') + path.sep))
  assert.deepEqual(await fs.readFile(path.join(root, 'essays/cities.md')), before)
  // It never shows up as a document of its own.
  assert.deepEqual(
    (await vault.listFiles()).map((f) => f.path),
    ['essays/cities.md'],
  )
})

test('no brief reads as empty, and an empty brief unpins', async () => {
  await vault.writeDoc('essays/plain.md', DOC)
  assert.equal(await readBrief('essays/plain.md'), '')
  assert.equal(await briefForPrompt('essays/plain.md'), '')
  assert.equal(await briefForPrompt(undefined), '')
  await writeBrief('essays/plain.md', 'Something')
  assert.ok(await exists(briefFile('essays/plain.md')))
  assert.equal(await writeBrief('essays/plain.md', ' \n '), '')
  assert.equal(await exists(briefFile('essays/plain.md')), false)
  assert.equal(await writeBrief('essays/plain.md', ''), '') // unpinning twice is fine
})

test('a brief is refused for a missing document, a path outside the vault, or too much text', async () => {
  await assert.rejects(writeBrief('essays/nope.md', 'x'), /No such document/)
  await assert.rejects(writeBrief('../outside.md', 'x'), /outside the vault/)
  await assert.rejects(writeBrief('essays/cities.txt', 'x'), /Not a document/)
  await assert.rejects(readBrief('../../etc/passwd.md'), /outside the vault/)
  await assert.rejects(writeBrief('essays/cities.md', 'x'.repeat(100_001)), /too long/)
  assert.equal(await briefForPrompt('../x.md'), '')
})

test('renaming keeps the brief; trashing moves it with the document; restoring brings it back', async () => {
  const next = await vault.renameDoc('essays/cities.md', 'City life')
  assert.equal(next, 'essays/city-life.md')
  assert.match(await readBrief(next), /^Evaluate the claim/)
  assert.equal(await exists(briefFile('essays/cities.md')), false)

  const moved = await vault.moveToFolder([], next, 'drafts')
  assert.match(await readBrief(moved), /^Evaluate the claim/)

  const item = await vault.trashDoc(moved)
  assert.equal(await exists(briefFile(moved)), false)
  assert.ok(await exists(path.join(root, '.ekdanta/trash', item.id, 'brief.md')))
  const back = await vault.restoreDoc(item.id)
  assert.equal(back, moved)
  assert.match(await readBrief(back), /^Evaluate the claim/)
})

test('a duplicate starts without the brief', async () => {
  const copy = await vault.duplicateDoc('drafts/city-life.md')
  assert.equal(await readBrief(copy), '')
  assert.match(await readBrief('drafts/city-life.md'), /^Evaluate/)
})

test('a new draft with only a brief pinned is not discarded as empty', async () => {
  const rel = await vault.createDoc([], '', 'essay')
  await writeBrief(rel, 'Answer the question.')
  assert.equal(await vault.discardIfEmpty(rel), false)
  assert.ok(await exists(path.join(root, rel)))
  await writeBrief(rel, '')
  assert.equal(await vault.discardIfEmpty(rel), true)
})
