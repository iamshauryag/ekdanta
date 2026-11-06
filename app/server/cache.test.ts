import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileCache } from './cache.ts'

async function vault() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-cache-'))
  await fs.mkdir(path.join(root, 'essays'))
  await fs.mkdir(path.join(root, '.ekdanta'))
  await fs.writeFile(path.join(root, 'a.md'), 'alpha')
  await fs.writeFile(path.join(root, 'essays', 'b.md'), 'beta')
  await fs.writeFile(path.join(root, '.ekdanta', 'hidden.md'), 'not listed')
  await fs.writeFile(path.join(root, 'essays', '.b.md.tmp'), 'half written')
  await fs.writeFile(path.join(root, 'notes.txt'), 'not markdown')
  return root
}

const parse = (rel: string, raw: string) => ({ path: rel, text: raw })

test('lists Markdown files, skipping dot-folders, temp files and other types', async () => {
  const root = await vault()
  const cache = createFileCache(root, parse)
  assert.deepEqual(await cache.list(), [
    { path: 'a.md', text: 'alpha' },
    { path: 'essays/b.md', text: 'beta' },
  ])
  await fs.rm(root, { recursive: true })
})

test('re-reads only files whose mtime changed', async () => {
  const root = await vault()
  const cache = createFileCache(root, parse)
  await cache.list()
  assert.equal(cache.reads, 2)
  await cache.list()
  assert.equal(cache.reads, 2, 'an unchanged vault is not read again')

  // An edit made outside Ekdanta: same size, new mtime.
  await fs.writeFile(path.join(root, 'a.md'), 'ALPHA')
  const later = new Date(Date.now() + 5000)
  await fs.utimes(path.join(root, 'a.md'), later, later)
  const list = await cache.list()
  assert.equal(cache.reads, 3)
  assert.equal(list.find((f) => f.path === 'a.md')?.text, 'ALPHA')
  await fs.rm(root, { recursive: true })
})

test('invalidate forces a re-read even when the mtime looks the same', async () => {
  const root = await vault()
  const cache = createFileCache(root, parse)
  const abs = path.join(root, 'a.md')
  const when = new Date('2026-01-01T00:00:00Z')
  await fs.utimes(abs, when, when)
  await cache.list()
  await fs.writeFile(abs, 'omega')
  await fs.utimes(abs, when, when)
  assert.equal((await cache.list()).find((f) => f.path === 'a.md')?.text, 'alpha', 'stale without invalidate')
  cache.invalidate('a.md')
  assert.equal((await cache.list()).find((f) => f.path === 'a.md')?.text, 'omega')
  await fs.rm(root, { recursive: true })
})

test('deleted and added files leave and join the listing', async () => {
  const root = await vault()
  const cache = createFileCache(root, parse)
  await cache.list()
  await fs.unlink(path.join(root, 'a.md'))
  await fs.writeFile(path.join(root, 'essays', 'c.md'), 'gamma')
  assert.deepEqual(
    (await cache.list()).map((f) => f.path),
    ['essays/b.md', 'essays/c.md'],
  )
  assert.equal(cache.reads, 3)
  await fs.rm(root, { recursive: true })
})

test('statAll never reads content', async () => {
  const root = await vault()
  const cache = createFileCache(root, parse)
  const stats = await cache.statAll()
  assert.equal(cache.reads, 0)
  assert.deepEqual(
    stats.map((s) => [s.path, s.size]),
    [
      ['a.md', 5],
      ['essays/b.md', 4],
    ],
  )
  assert.ok(stats.every((s) => s.mtime > 0))
  await fs.rm(root, { recursive: true })
})

test('a missing root lists nothing', async () => {
  const cache = createFileCache(path.join(os.tmpdir(), 'ekdanta-no-such-vault-' + Date.now()), parse)
  assert.deepEqual(await cache.list(), [])
})
