// Filing a piece by its kind: where a kind change moves it, what stays put, and what follows it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-place-'))
process.env.EKDANTA_VAULT = root
const vault = await import('./vault.ts')
const { editDocTags } = await import('./tags.ts')
const { DEFAULT_KINDS } = await import('../src/lib/kinds.ts')
const kinds = DEFAULT_KINDS
const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8')
const exists = (rel: string) =>
  fs.access(path.join(root, rel)).then(
    () => true,
    () => false,
  )
const doc = (platform: string, body = 'Text\n') => `---\ntitle: T\nplatform: ${platform}\n---\n\n${body}`

test.after(() => fs.rm(root, { recursive: true, force: true }))

test('a note in a folder of the writer’s own moves to its new kind’s folder', async () => {
  // The sample vault's notes/ holds `platform: note` pages: notes/ is no kind's folder.
  await vault.writeDoc('notes/on-craft.md', doc('essay'))
  await vault.appendHistory('notes/on-craft.md', { level: 1 })
  assert.deepEqual(await vault.fileByKind(kinds, 'notes/on-craft.md'), { path: 'essays/on-craft.md' })
  assert.equal(await exists('notes/on-craft.md'), false)
  assert.deepEqual(await vault.readHistory('essays/on-craft.md'), [{ level: 1 }], 'its sidecars follow')
})

test('a note already in its kind’s folder stays, at any depth', async () => {
  await vault.writeDoc('essays/2024/old.md', doc('essay'))
  assert.deepEqual(await vault.fileByKind(kinds, 'essays/2024/old.md'), { path: 'essays/2024/old.md' })
  // Nested in another kind's folder, it moves to the top of its own.
  await vault.writeDoc('essays/2024/post.md', doc('linkedin'))
  assert.equal(await vault.placeDoc(kinds, 'essays/2024/post.md'), 'linkedin/post.md')
})

test('a name already taken in the kind’s folder gets -2, and nothing is overwritten', async () => {
  await vault.writeDoc('emails/hello.md', doc('email', 'First\n'))
  await vault.writeDoc('drafts/hello.md', doc('email', 'Second\n'))
  assert.equal(await vault.placeDoc(kinds, 'drafts/hello.md'), 'emails/hello-2.md')
  assert.match(await read('emails/hello.md'), /First/)
  assert.match(await read('emails/hello-2.md'), /Second/)
})

test('special folders, excluded folders and the Brain keep their notes, and say why', async () => {
  await vault.writeDoc('templates/t.md', doc('linkedin'))
  assert.deepEqual(await vault.fileByKind(kinds, 'templates/t.md'), { path: 'templates/t.md', stay: 'special' })
  await vault.writeDoc('archive/2019/a.md', doc('linkedin'))
  assert.deepEqual(await vault.fileByKind(kinds, 'archive/2019/a.md', { excluded: ['archive'] }), { path: 'archive/2019/a.md', stay: 'excluded' })
  await vault.writeDoc('library/books/b.md', doc('essay'))
  assert.deepEqual(await vault.fileByKind(kinds, 'library/books/b.md', { brain: 'library' }), { path: 'library/books/b.md', stay: 'brain' })
  await vault.writeDoc('drafts/odd.md', doc('note'))
  assert.deepEqual(await vault.fileByKind(kinds, 'drafts/odd.md'), { path: 'drafts/odd.md', stay: 'unknown-kind' })
})

test('the kind’s folder is the one already in the vault, whatever its case', async () => {
  await fs.mkdir(path.join(root, 'Texts'), { recursive: true })
  await vault.writeDoc('drafts/sms.md', doc('text'))
  assert.equal(await vault.placeDoc(kinds, 'drafts/sms.md'), 'Texts/sms.md')
  // And a note in it counts as home, so a case-only move never happens.
  assert.equal(await vault.placeDoc(kinds, 'Texts/sms.md'), 'Texts/sms.md')
})

test('pictures and relative links still work from the new folder, and links by path follow', async () => {
  await fs.mkdir(path.join(root, 'attachments'), { recursive: true })
  await fs.writeFile(path.join(root, 'attachments/a.png'), '')
  await vault.writeDoc('loose.md', doc('blog', '![a](attachments/a.png) and [b](drafts/odd.md#top "B") `![c](attachments/c.png)` [w](https://x.y/a.png) [h](#here)\n'))
  await vault.writeDoc('drafts/refs.md', '[[loose]] and [[loose|the loose one]] and [[blog/other]]\n')
  await vault.writeDoc('drafts/path-refs.md', 'See [[deep/er/nested]].\n')
  assert.equal(await vault.placeDoc(kinds, 'loose.md'), 'blog/loose.md')
  assert.equal((await read('blog/loose.md')).split('\n\n')[1], '![a](../attachments/a.png) and [b](../drafts/odd.md#top "B") `![c](attachments/c.png)` [w](https://x.y/a.png) [h](#here)\n')
  assert.equal(await read('drafts/refs.md'), '[[loose]] and [[loose|the loose one]] and [[blog/other]]\n', 'links by name still find it')

  await vault.writeDoc('deep/er/nested.md', doc('blog', '![a](../../attachments/a.png)\n'))
  assert.equal(await vault.placeDoc(kinds, 'deep/er/nested.md'), 'blog/nested.md')
  assert.match(await read('blog/nested.md'), /!\[a\]\(\.\.\/attachments\/a\.png\)/)
  assert.equal(await read('drafts/path-refs.md'), 'See [[blog/nested]].\n')
})

test('a move that had to rename a page leaves links by name to the page that kept the name', async () => {
  await vault.writeDoc('scripts/intro.md', doc('youtube-script', 'Kept\n'))
  await vault.writeDoc('drafts/intro.md', doc('youtube-script', 'Moved\n'))
  await vault.writeDoc('drafts/intro-refs.md', '[[intro]] and [[drafts/intro]]\n')
  assert.equal(await vault.placeDoc(kinds, 'drafts/intro.md'), 'scripts/intro-2.md')
  assert.equal(await read('drafts/intro-refs.md'), '[[intro]] and [[scripts/intro-2]]\n')
})

test('rebaseLinks changes only links to files that are there, in every way Markdown writes them', () => {
  const files = new Set(['a/a.png', 'a/a_(1).png', 'a/my pic.png', 'a/ref.png', 'a/img.png', 'a/doc.md'])
  const isFile = (p: string) => files.has(p)
  const body = [
    '```',
    '![x](a.png)',
    '```',
    '![y](a.png) [z](../../outside.md) ![s](<my pic.png>) ![e](my%20pic.png)',
    '[w](www.example.com) [gone](missing.png) [d](doc.md#part "Title") [p](a_(1).png)',
    '',
    '    ![indented code](a.png)',
    '',
    '[ref]: ref.png "A title"',
    '<img src="img.png" alt="i"> <img alt=\'x\' src=\'a.png\'>',
    'Text `![inline](a.png)` after',
  ].join('\n')
  assert.equal(
    vault.rebaseLinks(body, 'a', 'b/c', isFile),
    [
      '```',
      '![x](a.png)',
      '```',
      '![y](../../a/a.png) [z](../../outside.md) ![s](<../../a/my pic.png>) ![e](../../a/my%20pic.png)',
      '[w](www.example.com) [gone](missing.png) [d](../../a/doc.md#part "Title") [p](../../a/a_(1).png)',
      '',
      '    ![indented code](a.png)',
      '',
      '[ref]: ../../a/ref.png "A title"',
      '<img src="../../a/img.png" alt="i"> <img alt=\'x\' src=\'../../a/a.png\'>',
      'Text `![inline](a.png)` after',
    ].join('\n'),
  )
  assert.equal(vault.rebaseLinks(body, 'a', 'a', isFile), body)
  // An indented line that continues a paragraph is text, not code.
  assert.equal(vault.rebaseLinks('Para\n    ![a](a.png)\n', 'a', 'b', isFile), 'Para\n    ![a](../a/a.png)\n')
})

test('a kind whose folder is set apart leaves the note where it is, and says so', async () => {
  const hidden = [
    { id: 'tpl', name: 'Template', folder: 'templates', guidance: '', words: 100 },
    { id: 'old', name: 'Old', folder: 'archive', guidance: '', words: 100 },
    { id: 'src', name: 'Source', folder: 'library', guidance: '', words: 100 },
  ]
  await vault.writeDoc('drafts/apart.md', doc('tpl'))
  assert.deepEqual(await vault.fileByKind(hidden, 'drafts/apart.md'), { path: 'drafts/apart.md', stay: 'target-special', folder: 'templates' })
  await vault.writeDoc('drafts/apart.md', doc('old'))
  assert.deepEqual(await vault.fileByKind(hidden, 'drafts/apart.md', { excluded: ['archive'] }), { path: 'drafts/apart.md', stay: 'target-excluded', folder: 'archive' })
  await vault.writeDoc('drafts/apart.md', doc('src'))
  assert.deepEqual(await vault.fileByKind(hidden, 'drafts/apart.md', { brain: 'library' }), { path: 'drafts/apart.md', stay: 'target-brain', folder: 'library' })
})

test('undo puts the kind and the place back, by the token the move gave', async () => {
  await vault.writeDoc('ideas-folder/piece.md', doc('essay'))
  const placed = await vault.fileByKind(kinds, 'ideas-folder/piece.md', { was: 'note' })
  assert.equal(placed.path, 'essays/piece.md')
  assert.ok(placed.undo)
  await vault.writeDoc('essays/piece.md', doc('essay', 'Edited after the move\n')) // edits don't stop an undo
  assert.equal(await vault.unfileDoc(placed.undo!), 'ideas-folder/piece.md')
  assert.match(await read('ideas-folder/piece.md'), /platform: note[\s\S]*Edited after the move/)
  await assert.rejects(vault.unfileDoc(placed.undo!), (e: Error & { status?: number }) => e.status === 409, 'a token is used once')
  // A kind that wasn't set before is taken away again.
  await vault.writeDoc('ideas-folder/bare.md', '---\ntitle: Bare\nplatform: essay\n---\n\nText\n')
  const bare = await vault.fileByKind(kinds, 'ideas-folder/bare.md', { was: '' })
  assert.equal(await vault.unfileDoc(bare.undo!), 'ideas-folder/bare.md')
  assert.doesNotMatch(await read('ideas-folder/bare.md'), /platform/)
  await assert.rejects(vault.unfileDoc('made-up'), (e: Error & { status?: number }) => e.status === 409)
})

test('a stale undo never acts on another note', async () => {
  // The note was renamed after the move, and a new note now has its old path.
  await vault.writeDoc('ideas-folder/stale.md', doc('essay', 'Original\n'))
  const a = await vault.fileByKind(kinds, 'ideas-folder/stale.md', { was: 'note' })
  await vault.renameDoc(a.path, 'Renamed')
  await vault.writeDoc(a.path, doc('essay', 'Someone else\n'))
  await assert.rejects(vault.unfileDoc(a.undo!), (e: Error & { status?: number }) => e.status === 409)
  assert.match(await read(a.path), /Someone else/)
  // The note went to the trash.
  await vault.writeDoc('ideas-folder/binned.md', doc('essay'))
  const b = await vault.fileByKind(kinds, 'ideas-folder/binned.md', { was: 'note' })
  await vault.trashDoc(b.path)
  await assert.rejects(vault.unfileDoc(b.undo!), (e: Error & { status?: number }) => e.status === 409)
  // Gone from disk outside Ekdanta.
  await vault.writeDoc('ideas-folder/vanished.md', doc('essay'))
  const c = await vault.fileByKind(kinds, 'ideas-folder/vanished.md', { was: 'note' })
  await fs.rm(path.join(root, c.path))
  await assert.rejects(vault.unfileDoc(c.undo!), (e: Error & { status?: number }) => e.status === 404)
})

test('Move to… keeps pictures working too', async () => {
  await vault.writeDoc('m.md', '![a](attachments/a.png)\n')
  assert.equal(await vault.moveToFolder(kinds, 'm.md', 'one/two'), 'one/two/m.md')
  assert.equal(await read('one/two/m.md'), '![a](../../attachments/a.png)\n')
})

test('tags are added and taken away on disk, keeping the rest of the front matter', async () => {
  await vault.writeDoc('drafts/tagged.md', '---\ntitle: Tagged\ntags: craft essays\n---\n\nBody #inline\n')
  assert.deepEqual(await editDocTags('drafts/tagged.md', ['#Voice', 'CRAFT'], ['essays']), ['craft', 'Voice'])
  assert.equal(await read('drafts/tagged.md'), '---\ntitle: Tagged\ntags:\n  - craft\n  - Voice\n---\n\nBody #inline\n')
  assert.deepEqual(await editDocTags('drafts/tagged.md', [], ['craft', 'voice']), [])
  assert.equal(await read('drafts/tagged.md'), '---\ntitle: Tagged\n---\n\nBody #inline\n')
  // The listing knows which tags are the front matter's.
  await editDocTags('drafts/tagged.md', ['one'], [])
  const f = (await vault.listFiles()).find((x) => x.path === 'drafts/tagged.md')
  assert.deepEqual(f?.fmTags, ['one'])
  assert.deepEqual(f?.tags, ['one', 'inline'])
  // Front matter Ekdanta can't rewrite is never touched.
  const odd = '---\nmeta:\n  nested: true\n---\n\nBody\n'
  await fs.writeFile(path.join(root, 'drafts/odd-fm.md'), odd)
  await assert.rejects(editDocTags('drafts/odd-fm.md', ['x'], []), /Can't tag/)
  assert.equal(await read('drafts/odd-fm.md'), odd)
  await assert.rejects(editDocTags('drafts/never.md', ['x'], []), (e: Error & { status?: number }) => e.status === 404)
})

test('a tag edit never writes over a change made on disk after it was read', async () => {
  const rel = 'drafts/raced.md'
  await vault.writeDoc(rel, '---\ntitle: Raced\ntags: [a]\n---\n\nOld body\n')
  let edits = 0
  // Reads the file, then someone else changes it (as Obsidian might) before the tag is written.
  const racing = async (r: string) => {
    const seen = await vault.readWithMtime(r)
    if (edits++ === 0) {
      await fs.writeFile(path.join(root, r), '---\ntitle: Raced\ntags: [a]\n---\n\nNew body from elsewhere\n')
      await fs.utimes(path.join(root, r), new Date(), new Date(Date.now() + 5000))
    }
    return seen
  }
  assert.deepEqual(await editDocTags(rel, ['b'], [], racing), ['a', 'b'])
  assert.equal(await read(rel), '---\ntitle: Raced\ntags: [a, b]\n---\n\nNew body from elsewhere\n')
  // A file that changes every time is left alone, with a 409.
  let n = 0
  const always = async (r: string) => {
    const seen = await vault.readWithMtime(r)
    await fs.writeFile(path.join(root, r), `---\ntitle: Raced\n---\n\nChange ${n}\n`)
    await fs.utimes(path.join(root, r), new Date(), new Date(Date.now() + 10000 * ++n))
    return seen
  }
  await assert.rejects(editDocTags(rel, ['c'], [], always), (e: Error & { status?: number }) => e.status === 409)
  assert.doesNotMatch(await read(rel), /- c|, c/)
})
