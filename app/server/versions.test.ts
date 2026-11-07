// Version history against a scratch vault: snapshots, the write hook, outside changes, retention.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-versions-'))
process.env.EKDANTA_VAULT = root
const vault = await import('./vault.ts')
const v = await import('./versions.ts')
const { retain, wordDelta, sentenceCount, deltaLabel, byDay, DAY, HOUR, MAX_UNNAMED } = await import('../src/lib/versions.ts')
const { DEFAULT_KINDS } = await import('../src/lib/kinds.ts')
const versionsDir = (key: string) => path.join(root, '.ekdanta', 'versions', key)
const doc = (body: string, title = 'A') => `---\ntitle: ${title}\n---\n\n${body}`

test.after(() => fs.rm(root, { recursive: true, force: true }))

const entry = (at: number, extra: Record<string, unknown> = {}) => ({
  id: new Date(at).toISOString().replace(/:/g, '-'),
  at: new Date(at).toISOString(),
  words: 1,
  reason: 'autosave',
  hash: String(at),
  ...extra,
})

test('retention keeps named versions, the last day, one an hour for a week and one a day after', () => {
  const now = Date.parse('2026-11-06T12:00:00Z')
  const entries = [
    // Two in the same hour, three days ago: only the newer stays.
    entry(now - 3 * DAY),
    entry(now - 3 * DAY + 10 * 60_000),
    // Two on the same day, a month ago: only the newer stays. A named one that day stays too.
    entry(now - 30 * DAY - 2 * HOUR),
    entry(now - 30 * DAY - HOUR),
    entry(now - 30 * DAY - 3 * HOUR, { name: 'first draft' }),
    // The last 24 hours: all of them.
    entry(now - 5 * 60_000),
    entry(now - 4 * 60_000),
    entry(now - 23 * HOUR),
  ]
  const kept = retain(entries, now).map((e) => e.at)
  const at = (t: number) => new Date(t).toISOString()
  assert.deepEqual(kept, [at(now - 30 * DAY - 3 * HOUR), at(now - 30 * DAY - HOUR), at(now - 3 * DAY + 10 * 60_000), at(now - 23 * HOUR), at(now - 5 * 60_000), at(now - 4 * 60_000)])
})

test(`retention keeps at most ${MAX_UNNAMED} unnamed versions, dropping the oldest, and every named one`, () => {
  const now = Date.parse('2026-11-06T12:00:00Z')
  const entries = Array.from({ length: MAX_UNNAMED + 30 }, (_, i) => entry(now - i * 60_000, i === MAX_UNNAMED + 20 ? { name: 'keep me' } : {}))
  const kept = retain(entries, now)
  assert.equal(kept.filter((e) => !e.name).length, MAX_UNNAMED)
  assert.ok(kept.some((e) => e.name === 'keep me'))
  // The newest unnamed ones survive.
  assert.equal(kept[kept.length - 1].at, new Date(now).toISOString())
})

test('word deltas, sentence counts and labels', () => {
  assert.deepEqual(wordDelta('one two three', 'one two three'), { added: 0, removed: 0 })
  assert.deepEqual(wordDelta('one two three', 'one four three five'), { added: 2, removed: 1 })
  assert.deepEqual(wordDelta('', 'a new paragraph'), { added: 3, removed: 0 })
  assert.equal(sentenceCount('One sentence only'), 1)
  assert.equal(sentenceCount('First. Second! Third?'), 3)
  assert.equal(sentenceCount('He said “stop.” Then left.'), 2)
  assert.equal(sentenceCount(''), 0)
  assert.equal(deltaLabel(0, 0), '0 words')
  assert.equal(deltaLabel(120, 30), '+120 / −30 words')
  assert.equal(deltaLabel(120, 0), '+120 words')
  assert.equal(deltaLabel(0, 30), '−30 words')
})

test('versions are grouped by day, newest first', () => {
  const now = new Date(2026, 10, 6, 15, 0)
  const rows = [new Date(2026, 10, 6, 9, 0), new Date(2026, 10, 5, 22, 0), new Date(2026, 10, 6, 14, 0), new Date(2026, 9, 1, 8, 0)].map((d) => ({ at: d.toISOString() }))
  const groups = byDay(rows, now)
  assert.deepEqual(
    groups.map((g) => [g.label, g.rows.length]),
    [
      ['Today', 2],
      ['Yesterday', 1],
      [groups[2].label, 1],
    ],
  )
  assert.equal(groups[0].rows[0].at, new Date(2026, 10, 6, 14, 0).toISOString())
})

test('a snapshot of identical text is skipped; a name goes on the latest version instead', async () => {
  // Writing a new file is its first version already.
  await vault.writeDoc('essays/same.md', doc('Hello there.'))
  const [first] = await v.listVersions('essays/same.md')
  assert.equal(first.reason, 'first save')
  assert.equal(await v.snapshot('essays/same.md', { reason: 'saved by you' }), null)
  const named = await v.snapshot('essays/same.md', { reason: 'saved by you', name: 'first' })
  assert.equal(named?.id, first.id)
  const list = await v.listVersions('essays/same.md')
  assert.equal(list.length, 1)
  assert.equal(list[list.length - 1].name, 'first')
  // The text is kept as a plain .md file.
  assert.equal(await v.readVersion('essays/same.md', first.id), doc('Hello there.'))
  await assert.rejects(v.readVersion('essays/same.md', '../../settings'), /No such version/)
})

test('the first save of a new document is its first version; later saves within five minutes add none', async () => {
  const rel = await vault.createDoc(DEFAULT_KINDS, 'essays')
  assert.deepEqual(await v.listVersions(rel), [])
  const created = await vault.readDoc(rel)
  await vault.writeDoc(rel, created + 'The first words.')
  let list = await v.listVersions(rel)
  assert.equal(list.length, 1)
  assert.equal(list[0].reason, 'first save')
  assert.equal(list[0].words, 3)
  assert.deepEqual([list[0].added, list[0].removed], [3, 0])
  await vault.writeDoc(rel, created + 'The first words, and more.')
  list = await v.listVersions(rel)
  assert.equal(list.length, 1)
})

test('a save more than five minutes after the last version keeps the text it replaces', async () => {
  await vault.writeDoc('essays/auto.md', doc('Version one.'))
  await vault.writeDoc('essays/auto.md', doc('Version two.')) // within five minutes: no version
  const list0 = await v.listVersions('essays/auto.md')
  assert.equal(list0.length, 1)
  // Pretend the latest version is old.
  const idx = path.join(versionsDir('essays__auto'), 'index.json')
  const entries = JSON.parse(await fs.readFile(idx, 'utf8'))
  entries[entries.length - 1].at = new Date(Date.now() - 6 * 60_000).toISOString()
  await fs.writeFile(idx, JSON.stringify(entries))
  await vault.writeDoc('essays/auto.md', doc('Version three.'))
  const list = await v.listVersions('essays/auto.md')
  assert.equal(list.length, 2)
  assert.equal(await v.readVersion('essays/auto.md', list[1].id), doc('Version two.'))
  assert.equal(list[list.length - 1].reason, 'autosave')
})

test('a front-matter-only change is a version of 0 words', async () => {
  await vault.writeDoc('essays/fm.md', doc('Same body here.', 'Old'))
  await v.snapshot('essays/fm.md', { reason: 'saved by you' })
  await v.snapshot('essays/fm.md', { reason: 'saved by you', content: doc('Same body here.', 'New') })
  const list = await v.listVersions('essays/fm.md')
  const last = list[list.length - 1]
  assert.deepEqual([last.added, last.removed], [0, 0])
  assert.equal(deltaLabel(last.added, last.removed), '0 words')
})

test('a change made outside Ekdanta keeps what Ekdanta last saved and the new text, once', async () => {
  await vault.writeDoc('essays/out.md', doc('First words.'))
  await vault.writeDoc('essays/out.md', doc('Written in Ekdanta.')) // not a version yet (within five minutes)
  await fs.appendFile(path.join(root, 'essays/out.md'), '\nAdded in a shell.\n')
  const outside = await fs.readFile(path.join(root, 'essays/out.md'), 'utf8')
  await v.checkOutside('essays/out.md')
  await v.checkOutside('essays/out.md') // opened again: nothing new
  const list = await v.listVersions('essays/out.md')
  const reasons = list.map((e) => e.reason)
  assert.deepEqual(reasons.slice(-2), ['last saved in Ekdanta', 'changed outside Ekdanta'])
  assert.equal(await v.readVersion('essays/out.md', list[list.length - 2].id), doc('Written in Ekdanta.'))
  assert.equal(await v.readVersion('essays/out.md', list[list.length - 1].id), outside)
  // Saving over it from Ekdanta doesn't add the pair again.
  await vault.writeDoc('essays/out.md', outside + 'More.')
  assert.equal((await v.listVersions('essays/out.md')).filter((e) => e.reason === 'changed outside Ekdanta').length, 1)
})

test('versions follow a rename, and trash then restore', async () => {
  await vault.writeDoc('essays/old-name.md', doc('Some text.', 'Old Name'))
  await v.snapshot('essays/old-name.md', { reason: 'saved by you', name: 'keep' })
  const next = await vault.renameDoc('essays/old-name.md', 'New Name')
  assert.equal(next, 'essays/new-name.md')
  assert.ok((await v.listVersions(next)).some((e) => e.name === 'keep'))
  assert.ok(await fs.stat(versionsDir('essays__new-name')).catch(() => null))
  assert.equal(await fs.stat(versionsDir('essays__old-name')).catch(() => null), null)
  const item = await vault.trashDoc(next)
  assert.deepEqual(await v.listVersions(next), [])
  const back = await vault.restoreDoc(item.id)
  assert.ok((await v.listVersions(back)).some((e) => e.name === 'keep'))
})

test('an untitled draft discarded while empty takes its versions with it', async () => {
  const rel = await vault.createDoc(DEFAULT_KINDS, '')
  const created = await vault.readDoc(rel)
  await vault.writeDoc(rel, created + 'Typed then deleted.')
  assert.equal((await v.listVersions(rel)).length, 1)
  await vault.writeDoc(rel, created)
  assert.equal(await vault.discardIfEmpty(rel), true)
  assert.equal(await fs.stat(versionsDir(vault.docKey(rel))).catch(() => null), null)
})

test('pruning deletes the files of versions that go', async () => {
  await vault.writeDoc('essays/prune.md', doc('now'))
  const a = await v.snapshot('essays/prune.md', { reason: 'x', content: doc('a'), at: new Date(Date.now() - 40 * DAY) })
  const b = await v.snapshot('essays/prune.md', { reason: 'x', content: doc('b'), at: new Date(Date.now() - 40 * DAY + 60_000) })
  const files = await fs.readdir(versionsDir('essays__prune'))
  assert.ok(!files.includes(a!.id + '.md'))
  assert.ok(files.includes(b!.id + '.md'))
})

test('a damaged index is rebuilt from the snapshot files', async () => {
  await vault.writeDoc('essays/broken.md', doc('Text.'))
  const s = await v.snapshot('essays/broken.md', { reason: 'saved by you', content: doc('Other text.') })
  await fs.writeFile(path.join(versionsDir('essays__broken'), 'index.json'), '{not json')
  const list = await v.listVersions('essays/broken.md')
  assert.equal(list.length, 2)
  assert.equal(list[1].id, s!.id)
  assert.equal(list[1].at, s!.at)
  assert.equal(list[1].reason, 'recovered')
})
