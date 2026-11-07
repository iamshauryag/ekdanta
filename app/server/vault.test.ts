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

test('a vault with nothing but material files in it counts as empty', async () => {
  assert.equal(await vault.vaultIsEmpty(), true)
  await fs.mkdir(path.join(root, 'drafts'), { recursive: true })
  assert.equal(await vault.vaultIsEmpty(), true, 'an empty folder is nothing')
  await fs.writeFile(path.join(root, 'ideas.md'), '- an idea\n')
  assert.equal(await vault.vaultIsEmpty(), true, 'ideas.md is material, not the writer’s pages')
  await fs.writeFile(path.join(root, 'drafts/ideas.md'), '# a page that happens to be called that\n')
  assert.equal(await vault.vaultIsEmpty(), false, 'special files count only at the top of the vault')
  await fs.rm(path.join(root, 'ideas.md'))
  await fs.rm(path.join(root, 'drafts'), { recursive: true, force: true })
})

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

test('overlapping saves of one document leave a record that matches the file', async () => {
  for (let round = 0; round < 5; round++) {
    await Promise.all(Array.from({ length: 25 }, (_, i) => vault.writeDoc('essays/race.md', `Version ${i}`)))
    const disk = await fs.readFile(path.join(root, 'essays/race.md'), 'utf8')
    const rec = await vault.lastWritten('essays/race.md')
    assert.equal(rec?.body, disk)
    assert.equal(rec?.hash, vault.hashOf(disk))
    assert.equal(rec?.mtime, (await fs.stat(path.join(root, 'essays/race.md'))).mtimeMs)
  }
  // A record whose two halves disagree is not trusted.
  await fs.writeFile(path.join(meta, 'written', 'essays__race.md'), 'something else')
  assert.equal(await vault.lastWritten('essays/race.md'), null)
})

test('a symlinked document is listed, and saving it writes through the link', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-outside-'))
  try {
    const target = path.join(outside, 'real.md')
    await fs.writeFile(target, '# Linked\n\nOld text.')
    await fs.symlink(target, path.join(root, 'essays/linked.md'))
    await fs.symlink(path.join(outside, 'gone.md'), path.join(root, 'essays/dangling.md'))
    const paths = (await vault.listFiles()).map((f) => f.path)
    assert.ok(paths.includes('essays/linked.md'))
    assert.ok(!paths.includes('essays/dangling.md'))
    await vault.writeDoc('essays/linked.md', '# Linked\n\nEdited in Ekdanta.')
    assert.ok((await fs.lstat(path.join(root, 'essays/linked.md'))).isSymbolicLink())
    assert.equal(await fs.readFile(target, 'utf8'), '# Linked\n\nEdited in Ekdanta.')
    assert.equal((await vault.lastWritten('essays/linked.md'))?.mtime, (await fs.stat(target)).mtimeMs)
    await fs.rm(path.join(root, 'essays/dangling.md'))
  } finally {
    await fs.rm(outside, { recursive: true, force: true })
    await fs.rm(path.join(root, 'essays/linked.md'), { force: true })
  }
})

test('saving keeps a document’s permissions and its hard links', async () => {
  const abs = path.join(root, 'essays/private.md')
  await vault.writeDoc('essays/private.md', 'secret')
  await fs.chmod(abs, 0o600)
  await vault.writeDoc('essays/private.md', 'still secret')
  assert.equal((await fs.stat(abs)).mode & 0o777, 0o600)
  const other = path.join(root, 'other-name.md')
  await fs.link(abs, other)
  await vault.writeDoc('essays/private.md', 'seen by both names')
  assert.equal(await fs.readFile(other, 'utf8'), 'seen by both names')
  await fs.rm(other)
})

test('writing what is already there changes nothing, not even the mtime', async () => {
  const abs = path.join(root, 'essays/same.md')
  const { mtime } = await vault.writeDoc('essays/same.md', 'unchanged')
  const seen: string[] = []
  const off = vault.onBeforeWrite((w) => void seen.push(w.reason))
  try {
    await new Promise((r) => setTimeout(r, 15))
    const again = await vault.writeDoc('essays/same.md', 'unchanged')
    assert.equal(again.mtime, mtime)
    assert.equal((await fs.stat(abs)).mtimeMs, mtime)
    assert.deepEqual(seen, [], 'no hooks for a write that writes nothing')
  } finally {
    off()
  }
  // The same text arriving from outside: the record catches up, so it isn't taken for an outside edit.
  await fs.writeFile(abs, 'from outside')
  await vault.writeDoc('essays/same.md', 'from outside')
  assert.equal((await vault.lastWritten('essays/same.md'))?.mtime, (await fs.stat(abs)).mtimeMs)
})

test('a save based on an older version is refused with what is on disk, and a gone file is not brought back', async () => {
  const { mtime } = await vault.writeDoc('essays/two.md', 'base')
  const theirs = await vault.writeDoc('essays/two.md', 'their edit', { baseMtime: mtime })
  await assert.rejects(vault.writeDoc('essays/two.md', 'my edit', { baseMtime: mtime }), (e: unknown) => {
    assert.ok(e instanceof vault.StaleWrite)
    assert.equal(e.content, 'their edit')
    assert.equal(e.mtime, theirs.mtime)
    return true
  })
  // Same text as theirs: nothing to fight over.
  assert.equal((await vault.writeDoc('essays/two.md', 'their edit', { baseMtime: mtime })).mtime, theirs.mtime)
  // Keep mine: write again on top of the version now on disk.
  await vault.writeDoc('essays/two.md', 'my edit', { baseMtime: theirs.mtime })
  assert.equal(await fs.readFile(path.join(root, 'essays/two.md'), 'utf8'), 'my edit')

  await assert.rejects(vault.writeDoc('essays/gone.md', 'x', { create: false }), vault.MissingDoc)
  assert.equal(await exists(path.join(root, 'essays/gone.md')), false)
  await vault.writeDoc('essays/gone.md', 'x', { create: true, baseMtime: 123 })
  assert.equal(await fs.readFile(path.join(root, 'essays/gone.md'), 'utf8'), 'x')
  assert.deepEqual(await vault.readWithMtime('essays/nowhere.md'), null)
  assert.equal((await vault.readWithMtime('essays/gone.md'))?.mtime, (await fs.stat(path.join(root, 'essays/gone.md'))).mtimeMs)
})

test('a rename reports every document it touched, with the mtime now on disk', async () => {
  await vault.writeDoc('essays/linker.md', '---\ntitle: Linker\n---\n\nSee [[target]].')
  await vault.writeDoc('essays/target.md', '---\ntitle: Target\n---\n\nHere.')
  const { result: next, touched } = await vault.collectTouched(() => vault.renameDoc('essays/target.md', 'Aim'))
  assert.equal(next, 'essays/aim.md')
  const byPath = new Map(touched.map((t) => [t.path, t.mtime]))
  for (const p of ['essays/aim.md', 'essays/linker.md']) assert.equal(byPath.get(p), (await fs.stat(path.join(root, p))).mtimeMs, p)
  assert.match(await fs.readFile(path.join(root, 'essays/linker.md'), 'utf8'), /\[\[aim\]\]/)
  // Writes outside a collector aren't recorded anywhere.
  const outside = await vault.collectTouched(async () => 1)
  assert.deepEqual(outside.touched, [])
})

test('changesSince sees outside edits, new and deleted files from stats alone', async () => {
  const { now } = await vault.changesSince()
  await fs.writeFile(path.join(root, 'essays/outside-new.md'), 'new')
  const later = new Date(Date.now() + 20_000)
  await fs.utimes(path.join(root, 'essays/aim.md'), later, later)
  await fs.rm(path.join(root, 'essays/linker.md'))
  const c = await vault.changesSince(now)
  assert.ok(c.now > now)
  assert.deepEqual(
    c.created.map((x) => x.path),
    ['essays/outside-new.md'],
  )
  assert.deepEqual(
    c.changed.map((x) => x.path),
    ['essays/aim.md'],
  )
  assert.equal(c.changed[0].mtime, later.getTime())
  assert.deepEqual(c.deleted, ['essays/linker.md'])
  // Nothing new since then.
  const quiet = await vault.changesSince(c.now)
  assert.deepEqual([quiet.changed, quiet.created, quiet.deleted], [[], [], []])
  // Created then deleted between two polls: nothing to report.
  await fs.writeFile(path.join(root, 'essays/blip.md'), 'x')
  await vault.changesSince(quiet.now - 1) // a scan in between sees it appear
  await fs.rm(path.join(root, 'essays/blip.md'))
  const net = await vault.changesSince(quiet.now)
  assert.equal(
    [...net.created, ...net.changed].some((x) => x.path === 'essays/blip.md'),
    false,
  )
  assert.equal(net.deleted.includes('essays/blip.md'), false)
  // A time from before the log began asks the client to start over.
  assert.equal((await vault.changesSince(0)).reset, true)
})

test('polling a 5,000-file vault reads no file contents', async () => {
  const big = path.join(root, 'big')
  await fs.mkdir(big, { recursive: true })
  await Promise.all(Array.from({ length: 5000 }, (_, i) => fs.writeFile(path.join(big, `n${i}.md`), `note ${i}`)))
  const { now } = await vault.changesSince()
  const real = { readFile: fs.readFile, open: fs.open }
  let reads = 0
  fs.readFile = ((...a: Parameters<typeof fs.readFile>) => (reads++, real.readFile(...a))) as typeof fs.readFile
  fs.open = ((...a: Parameters<typeof fs.open>) => (reads++, real.open(...a))) as typeof fs.open
  try {
    const later = new Date(Date.now() + 30_000)
    await fs.utimes(path.join(big, 'n42.md'), later, later)
    const c = await vault.changesSince(now)
    assert.deepEqual(
      c.changed.map((x) => x.path),
      ['big/n42.md'],
    )
  } finally {
    fs.readFile = real.readFile
    fs.open = real.open
  }
  assert.equal(reads, 0)
})

test('a new piece of a kind with document defaults starts with them in its front matter', async () => {
  const kinds = [
    ...DEFAULT_KINDS,
    { id: 'academic-essay', name: 'Academic essay', folder: 'academic-essays', guidance: '', words: 1500, doc: { layout: 'page' as const, style: 'mla' as const, target: '<=1500' } },
  ]
  const rel = await vault.createDoc(kinds, 'academic-essays')
  const text = await fs.readFile(path.join(root, rel), 'utf8')
  assert.match(text, /^---\ntitle: \nplatform: academic-essay\nstatus: draft\ncreated: \d{4}-\d{2}-\d{2}\nlayout: page\nstyle: mla\ntarget: <=1500\n---\n\n$/)
  const plain = await fs.readFile(path.join(root, await vault.createDoc(kinds, 'linkedin')), 'utf8')
  assert.doesNotMatch(plain, /layout|style|target/)
})

// ---- Names in any script, and renaming a folder ----

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('a new document takes its name from a title in any script, once', async () => {
  const rel = await vault.createDoc(DEFAULT_KINDS, 'scripts-test')
  const named = await vault.nameDoc(rel, 'मेरा निबंध')
  assert.equal(named, 'scripts-test/मेरा-निबंध.md')
  // Committing the same title again changes nothing.
  assert.equal(await vault.renameDoc(named, 'मेरा निबंध'), named)
  assert.deepEqual((await fs.readdir(path.join(root, 'scripts-test'))).sort(), ['मेरा-निबंध.md'])
})

test('a title with nothing nameable gets a dated name, and "Untitled" stays put', async () => {
  const rel = await vault.createDoc(DEFAULT_KINDS, 'emoji-test')
  assert.equal(await vault.nameDoc(rel, '🎉✨'), `emoji-test/note-${today()}.md`)
  const other = await vault.createDoc(DEFAULT_KINDS, 'emoji-test')
  assert.equal(other, 'emoji-test/untitled.md')
  assert.equal(await vault.nameDoc(other, 'Untitled'), other)
  assert.equal(await vault.nameDoc(other, 'Notes: a/b'), 'emoji-test/notes-a-b.md')
})

test('a decomposed (NFD) file name is the same name as its composed title', async () => {
  // macOS can list a file name decomposed: Hangul as jamo, say.
  const rel = 'nfd/' + '한국어-노트'.normalize('NFD') + '.md'
  await vault.writeDoc(rel, '---\ntitle: 한국어 노트\n---\n\nHi')
  assert.equal(await vault.renameDoc(rel, '한국어 노트'), rel)
  // Latin keeps its old mapping: a retitle to the same title never moves café-notes → cafe-notes again.
  await vault.writeDoc('nfd/cafe-notes.md', '---\ntitle: Café notes\n---\n')
  assert.equal(await vault.renameDoc('nfd/cafe-notes.md', 'Café notes'), 'nfd/cafe-notes.md')
})

test('renameFolder moves documents with their sidecars, merges, and keeps links working', async () => {
  await vault.writeDoc('yt-scriptses/intro.md', '---\ntitle: Intro\nplatform: yt-scripts\n---\n\nHello')
  await vault.writeDoc('yt-scriptses/deep/outro.md', '---\ntitle: Outro\n---\n\nBye')
  await vault.writeDoc('yt-scripts/intro.md', '---\ntitle: Old intro\n---\n\nAlready here')
  await vault.writeDoc('linking.md', 'See [[intro]] and [[yt-scriptses/deep/outro|the end]].')
  await vault.appendHistory('yt-scriptses/intro.md', { level: 2 })
  await fs.writeFile(path.join(root, 'yt-scriptses/cover.png'), 'png')
  await fs.writeFile(path.join(root, 'yt-scriptses/.DS_Store'), '')

  const moved = await vault.renameFolder('yt-scriptses', 'yt-scripts')
  assert.deepEqual(moved.map((m) => m.to).sort(), ['yt-scripts/deep/outro.md', 'yt-scripts/intro-2.md'])
  assert.equal(await exists(path.join(root, 'yt-scriptses')), false, 'the old folder is gone')
  assert.equal(await exists(path.join(root, 'yt-scripts/cover.png')), true)
  assert.match(await vault.readDoc('yt-scripts/intro.md'), /Already here/)
  assert.deepEqual(await vault.readHistory('yt-scripts/intro-2.md'), [{ level: 2 }])
  assert.equal(await vault.readDoc('linking.md'), 'See [[intro-2]] and [[yt-scripts/deep/outro|the end]].')
  await assert.rejects(vault.renameFolder('yt-scripts', 'yt-scripts/inner'), /inside itself/)
  await assert.rejects(vault.renameFolder('nowhere', 'somewhere'), /no nowhere/)
  await assert.rejects(vault.renameFolder('../x', 'y'), /Not a folder|outside/)
})

test('clearHistory empties the log, and a document without one is fine', async () => {
  await vault.writeDoc('clear/a.md', 'x')
  await vault.appendHistory('clear/a.md', { level: 1 })
  await vault.clearHistory('clear/a.md')
  assert.deepEqual(await vault.readHistory('clear/a.md'), [])
  await vault.clearHistory('clear/never.md')
  await assert.rejects(vault.clearHistory('../x.md'), /outside/)
})

test('a page whose front matter cannot be rewritten is not renamed, copied or filed as a kind', async () => {
  const content = '---\nmeta:\n  nested: true\ntitle: Odd\n---\n\nBody\n'
  await fs.mkdir(path.join(root, 'odd'), { recursive: true })
  await fs.writeFile(path.join(root, 'odd/odd.md'), content)
  await assert.rejects(vault.renameDoc('odd/odd.md', 'Even'), (e: Error & { status?: number }) => e.status === 409 && /Can't rename “Odd”/.test(e.message))
  await assert.rejects(vault.duplicateDoc('odd/odd.md'), /Can't duplicate/)
  const kind = DEFAULT_KINDS[0]
  await assert.rejects(vault.moveToFolder(DEFAULT_KINDS, 'odd/odd.md', kind.folder), /Can't move/)
  assert.equal(await fs.readFile(path.join(root, 'odd/odd.md'), 'utf8'), content, 'the file is untouched')
  // A folder that isn't a kind's needs no front-matter change, so the page can go there.
  assert.equal(await vault.moveToFolder(DEFAULT_KINDS, 'odd/odd.md', 'elsewhere'), 'elsewhere/odd.md')
  assert.equal(await fs.readFile(path.join(root, 'elsewhere/odd.md'), 'utf8'), content)
})
