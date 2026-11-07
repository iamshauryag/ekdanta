// Search across a scratch vault: what's left out, filters, the row limit, and the match to select.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-search-'))
process.env.EKDANTA_VAULT = root
const { searchVault, searchReads } = await import('./search.ts')
const put = async (rel: string, content: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), content)
}

test.after(() => fs.rm(root, { recursive: true, force: true }))

test('search skips Ekdanta’s folder, the trash and special folders, and filters by kind', async () => {
  await put('essays/slow.md', '---\ntitle: Slow\nplatform: essay\n---\n\nA **slow** start.\n\nThen slow again, and slow.\n')
  await put('emails/slow.md', '---\ntitle: Slow mail\nplatform: email\n---\n\nSlow reply.\n')
  await put('templates/essay.md', '---\ntitle: Template\nplatform: essay\n---\n\nslow template\n')
  await put('.ekdanta/trash/abc/doc.md', 'slow in the trash\n')
  const all = await searchVault('slow')
  assert.deepEqual(all.files.map((f) => f.path).sort(), ['emails/slow.md', 'essays/slow.md'])
  const essays = await searchVault('slow kind:essay')
  assert.deepEqual(
    essays.files.map((f) => f.path),
    ['essays/slow.md'],
  )
  // By its name too.
  assert.deepEqual(
    (await searchVault('slow kind:Emails')).files.map((f) => f.path),
    ['emails/slow.md'],
  )
  const hits = essays.files[0].hits
  assert.equal(hits[0].text, 'A slow start.') // Markdown taken out
  assert.deepEqual(hits[0].ranges, [[2, 6]])
  assert.deepEqual(
    hits.map((h) => h.select),
    [
      { text: 'slow', nth: 0 },
      { text: 'slow', nth: 1 },
    ],
  )
  assert.deepEqual(essays.files[0].titleRanges, [[0, 4]])
  // The count is of matches, not lines: one in the title, one in the first line, two in the second.
  assert.equal(essays.matches, 4)
  assert.equal(essays.total, 2)
  assert.equal(essays.documents, 1)
  // Filters alone match documents, with nothing in them to count.
  const byKind = await searchVault('kind:essay')
  assert.equal(byKind.documents, 1)
  assert.equal(byKind.matches, 0)
})

test('short queries and broken regexes ask nothing of the vault', async () => {
  assert.deepEqual(await searchVault('s'), { files: [], total: 0, matches: 0, documents: 0, more: false })
  const bad = await searchVault('/[/')
  assert.match(bad.error ?? '', /character class/)
})

test('a large vault: the limit holds, and a repeat search reads nothing again', async () => {
  for (let i = 0; i < 5000; i++) await put(`big/n${i}.md`, `---\ntitle: Note ${i}\n---\n\nA line about writing, number ${i}.\n`)
  const t0 = Date.now()
  const first = await searchVault('writing', { limit: 200 })
  const firstMs = Date.now() - t0
  assert.equal(
    first.files.reduce((n, f) => n + Math.max(1, f.hits.length), 0),
    200,
  )
  assert.equal(first.total, 5000)
  assert.equal(first.documents, 5000)
  assert.equal(first.matches, 5000)
  assert.equal(first.more, true)
  const reads = searchReads()
  const t1 = Date.now()
  const again = await searchVault('writing number', { limit: 300 })
  const againMs = Date.now() - t1
  assert.equal(searchReads(), reads)
  assert.equal(again.files.length, 300)
  assert.ok(againMs < 5000, `${firstMs} ms then ${againMs} ms`)
})
