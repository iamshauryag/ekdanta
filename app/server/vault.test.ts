// The vault layer against a scratch vault: the write pipeline, the write record and sidecars.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-vault-'))
process.env.EKDANTA_VAULT = root
const vault = await import('./vault.ts')
const { DEFAULT_KINDS } = await import('../src/lib/kinds.ts')
const exists = (abs: string) =>
  fs.access(abs).then(
    () => true,
    () => false,
  )
const meta = path.join(root, '.ekdanta')

test.after(() => fs.rm(root, { recursive: true, force: true }))

test('writeDoc is atomic, returns the mtime and records what it wrote', async () => {
  const { mtime } = await vault.writeDoc('essays/a.md', 'first')
  assert.equal(mtime, (await fs.stat(path.join(root, 'essays/a.md'))).mtimeMs)
  assert.deepEqual(await fs.readdir(path.join(root, 'essays')), ['a.md'])
  const rec = await vault.lastWritten('essays/a.md')
  assert.equal(rec?.body, 'first')
  assert.equal(rec?.mtime, mtime)
  assert.equal(rec?.hash, vault.hashOf('first'))
  assert.equal(await vault.lastWritten('essays/never.md'), null)
  await assert.rejects(vault.writeDoc('../outside.md', 'x'), /outside the vault/)
  await assert.rejects(vault.writeDoc('essays/a.txt', 'x'), /Only .md/)
})

test('hooks see the old and new content, and a throwing hook never blocks the save', async () => {
  const seen: unknown[] = []
  const off1 = vault.onBeforeWrite((w) => {
    seen.push([w.path, w.oldContent, w.newContent, w.reason])
  })
  const off2 = vault.onBeforeWrite(async () => {
    throw new Error('hook broke')
  })
  const err = console.error
  console.error = () => {}
  try {
    await vault.writeDoc('essays/a.md', 'second')
    await vault.writeDoc('essays/new.md', 'fresh', { reason: 'create' })
  } finally {
    console.error = err
    off1()
    off2()
  }
  assert.deepEqual(seen, [
    ['essays/a.md', 'first', 'second', 'save'],
    ['essays/new.md', null, 'fresh', 'create'],
  ])
  assert.equal(await fs.readFile(path.join(root, 'essays/a.md'), 'utf8'), 'second')
  await vault.writeDoc('essays/a.md', 'third')
  assert.equal(seen.length, 2, 'unregistered hooks stop running')
})

test('listFiles sees Ekdanta writes at once and outside edits by mtime', async () => {
  await vault.writeDoc('essays/b.md', '---\ntitle: Bee\n---\n\nBody')
  assert.equal((await vault.listFiles()).find((f) => f.path === 'essays/b.md')?.title, 'Bee')
  await vault.writeDoc('essays/b.md', '---\ntitle: Bea\n---\n\nBody')
  assert.equal((await vault.listFiles()).find((f) => f.path === 'essays/b.md')?.title, 'Bea')
  const abs = path.join(root, 'essays/b.md')
  await fs.writeFile(abs, '---\ntitle: Outside\n---\n')
  const later = new Date(Date.now() + 10_000)
  await fs.utimes(abs, later, later)
  assert.equal((await vault.listFiles()).find((f) => f.path === 'essays/b.md')?.title, 'Outside')
  assert.ok((await vault.statAll()).some((s) => s.path === 'essays/b.md' && s.size > 0))
})

test('rename, trash and restore carry every registered sidecar, the write record included', async () => {
  const seen: string[] = []
  vault.registerSidecar('test.json', (rel) => {
    seen.push(rel)
    return path.join(meta, 'test', vault.docKey(rel) + '.json')
  })
  assert.throws(() => vault.registerSidecar('test.json', () => ''), /already registered/)
  assert.throws(() => vault.registerSidecar('doc.md', () => ''), /Bad sidecar/)
  await vault.writeDoc('essays/c.md', '---\ntitle: Sea\n---\n\nWaves.')
  await vault.appendHistory('essays/c.md', { level: 1 })
  await fs.mkdir(path.join(meta, 'test'), { recursive: true })
  await fs.writeFile(path.join(meta, 'test', 'essays__c.json'), '{}')

  const next = await vault.renameDoc('essays/c.md', 'The Open Sea')
  assert.equal(next, 'essays/the-open-sea.md')
  assert.equal(await exists(path.join(meta, 'written', 'essays__c.md')), false)
  assert.match((await vault.lastWritten(next))!.body, /title: The Open Sea/)
  assert.equal(await exists(path.join(meta, 'history', 'essays__the-open-sea.jsonl')), true)
  assert.equal(await exists(path.join(meta, 'test', 'essays__the-open-sea.json')), true)

  const item = await vault.trashDoc(next)
  assert.equal(await vault.lastWritten(next), null)
  const parts = await fs.readdir(path.join(meta, 'trash', item.id))
  for (const p of ['doc.md', 'history.jsonl', 'written.md', 'written.json', 'test.json', 'info.json']) assert.ok(parts.includes(p), p)
  assert.equal(
    (await vault.listFiles()).some((f) => f.path === next),
    false,
  )

  const back = await vault.restoreDoc(item.id)
  assert.equal(back, next)
  assert.match((await vault.lastWritten(back))!.body, /Waves/)
  assert.equal(await exists(path.join(meta, 'test', 'essays__the-open-sea.json')), true)
  assert.equal(await exists(path.join(meta, 'trash', item.id)), false)
  assert.equal(
    (await vault.listFiles()).some((f) => f.path === back),
    true,
  )
})

test('special folders stay put when their kind changes', async () => {
  await vault.writeDoc('templates/post.md', '---\nplatform: linkedin\n---\n\n*Prompt: Hook*')
  assert.equal(await vault.placeDoc(DEFAULT_KINDS, 'templates/post.md'), 'templates/post.md')
  await vault.writeDoc('loose.md', '---\nplatform: linkedin\n---\n\nText')
  assert.equal(await vault.placeDoc(DEFAULT_KINDS, 'loose.md'), 'linkedin/loose.md')
})

test('discarding an empty untitled draft takes its sidecars with it', async () => {
  const rel = await vault.createDoc(DEFAULT_KINDS, 'essays')
  assert.equal(rel, 'essays/untitled.md')
  assert.ok(await vault.lastWritten(rel))
  await vault.appendHistory(rel, { level: 1 })
  assert.equal(await vault.discardIfEmpty(rel), true)
  assert.equal(await vault.lastWritten(rel), null)
  assert.equal(await exists(path.join(meta, 'history', 'essays__untitled.jsonl')), false)
})
