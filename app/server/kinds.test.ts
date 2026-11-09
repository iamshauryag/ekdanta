// Kinds are folders, against a scratch vault laid out like a writer's own: their top-level folders
// become their kinds on first open, settings carry over, and making, renaming or removing a kind is
// making, renaming or removing its folder. No note is rewritten by any of it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-kinds-'))
process.env.EKDANTA_VAULT = root
const vault = await import('./vault.ts')
const kinds = await import('./kinds.ts')
const { loadSettings } = await import('./settings.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))

const put = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), text)
}
const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8')
const exists = (rel: string) =>
  fs.access(path.join(root, rel)).then(
    () => true,
    () => false,
  )
const mtimes = async (rels: string[]) => Promise.all(rels.map(async (r) => (await fs.stat(path.join(root, r))).mtimeMs))

const NOTES = ['Essays/on-walking.md', 'Essays/2024/spring.md', 'Book chapters/one.md', 'Letters/to-amma.md', 'Notes/odds.md', 'loose.md', 'stray.md', 'templates/post.md']

test('first open: the writer’s folders are their kinds, settings carry over, and nothing is rewritten', async () => {
  // Settings from before: a customised essay, and a LinkedIn kind with no folder in this vault.
  await put(
    '.ekdanta/settings.json',
    JSON.stringify({
      kinds: [
        { id: 'essay', name: 'Essay', folder: 'essays', guidance: 'long and slow', words: 3000 },
        { id: 'linkedin', name: 'LinkedIn post', folder: 'linkedin', guidance: 'short', words: 200 },
      ],
    }),
  )
  await put('Essays/on-walking.md', '---\ntitle: On walking\nplatform: essay\n---\n\nText\n')
  await put('Essays/2024/spring.md', '---\ntitle: Spring\nplatform: linkedin\n---\n\nThe folder wins.\n')
  await put('Book chapters/one.md', '---\ntitle: One\n---\n\nChapter\n')
  await put('Letters/to-amma.md', '# To Amma\n')
  await put('Notes/odds.md', 'odds and ends\n')
  await put('loose.md', '---\nplatform: essay\n---\n\nAt the top\n')
  await put('stray.md', 'No front matter\n')
  await put('templates/post.md', '---\ntemplate-name: Post\nplatform: linkedin\n---\n\n*Prompt: Hook*\n')
  await fs.mkdir(path.join(root, 'attachments'), { recursive: true })
  await fs.mkdir(path.join(root, '.obsidian'), { recursive: true })
  const before = await mtimes(NOTES)

  const list = await kinds.vaultKinds()
  assert.deepEqual(
    list.map((k) => `${k.id}:${k.folder}:${k.name}`),
    ['essay:Essays:Essay', 'book-chapter:Book chapters:Book chapter', 'letter:Letters:Letter', 'note:Notes:Note'],
  )
  assert.equal(list[0].guidance, 'long and slow', 'the essay settings carry over to the Essays folder')
  assert.ok(!list.some((k) => k.id === 'linkedin'), 'a kind with no folder doesn’t clutter the list')
  assert.equal((await loadSettings()).kinds.find((k) => k.id === 'linkedin')?.guidance, 'short', 'but its settings are kept')

  const files = await vault.listFiles()
  const kindOf = (p: string) => files.find((f) => f.path === p)?.platform
  assert.equal(kindOf('Essays/on-walking.md'), 'essay')
  assert.equal(kindOf('Essays/2024/spring.md'), 'essay', 'a subfolder is its parent’s kind; the folder beats front matter')
  assert.equal(kindOf('Book chapters/one.md'), 'book-chapter')
  assert.equal(kindOf('Letters/to-amma.md'), 'letter')
  assert.equal(kindOf('loose.md'), undefined, 'the top of the vault is Unfiled, never a pretend essay')
  assert.equal(kindOf('stray.md'), undefined)
  assert.equal(kindOf('templates/post.md'), undefined, 'linkedin isn’t one of the kinds here, so the template is for any kind')
  assert.deepEqual(await mtimes(NOTES), before, 'no note was rewritten')
  assert.match(await read('Essays/2024/spring.md'), /platform: linkedin/)
})

test('a new folder is a kind at once, and an empty one still is', async () => {
  await fs.mkdir(path.join(root, 'Speeches'), { recursive: true })
  assert.equal((await kinds.vaultKinds()).find((k) => k.folder === 'Speeches')?.name, 'Speech')
})

test('a new draft takes its folder’s kind; at the top of the vault it is Unfiled', async () => {
  const list = await kinds.vaultKinds()
  const inLetters = await vault.createDoc(list, 'Letters')
  assert.match(await read(inLetters), /^platform: letter$/m)
  const deep = await vault.createDoc(list, 'Essays/2024')
  assert.match(deep, /^Essays\/2024\/untitled/)
  assert.match(await read(deep), /^platform: essay$/m)
  const top = await vault.createDoc(list, '')
  assert.doesNotMatch(await read(top), /platform/)
  // With a kind, in that kind's folder.
  const asked = await vault.createDoc(list, '', { kind: 'note' })
  assert.match(asked, /^Notes\//)
})

test('choosing a suggested kind makes its folder; a kind the writer had before comes back as it was', async () => {
  const made = await kinds.kindFor('email')
  assert.equal(made?.folder, 'emails')
  assert.ok(await exists('emails'))
  const back = await kinds.kindFor('linkedin')
  assert.equal(back?.guidance, 'short', 'its saved settings come back with it')
  assert.ok(await exists('linkedin'))
  assert.equal(await kinds.kindFor('not-a-kind'), undefined)
  assert.ok((await kinds.vaultKinds()).some((k) => k.id === 'linkedin'))
})

test('Settings → Kinds: adding makes a folder, removing takes away only an empty one, settings stay', async () => {
  const now = await kinds.vaultKinds()
  const blog = { id: 'blog', name: 'Blog post', folder: 'blog', guidance: '', words: 900 }
  let next = await kinds.saveVisibleKinds([...now, blog])
  assert.ok(await exists('blog'))
  assert.ok(next.some((k) => k.id === 'blog'))
  // Edits keep the folder and name (those change by renaming) and take the rest.
  next = await kinds.saveVisibleKinds(next.map((k) => (k.id === 'letter' ? { ...k, guidance: 'warm', name: 'Typed over', folder: 'elsewhere' } : k)))
  const letter = next.find((k) => k.id === 'letter')!
  assert.deepEqual([letter.guidance, letter.name, letter.folder], ['warm', 'Letter', 'Letters'])
  // A kind left out of what was sent is kept: the app may not have seen it yet (a folder just made in Finder).
  await fs.mkdir(path.join(root, 'Unseen'), { recursive: true })
  next = await kinds.saveVisibleKinds(next)
  assert.ok(await exists('Unseen'))
  assert.ok(next.some((k) => k.folder === 'Unseen'))
  // Removing is by id. A folder with notes in it can't be removed.
  await assert.rejects(kinds.removeKind('letter'), (e: Error & { status?: number }) => e.status === 409 && /Letters\/ still has notes/.test(e.message))
  assert.ok(await exists('Letters/to-amma.md'))
  // An empty one goes (a .DS_Store and empty folders inside don't count), and its settings wait for it.
  await put('blog/.DS_Store', '')
  await fs.mkdir(path.join(root, 'blog/drafts'), { recursive: true })
  next = await kinds.removeKind('blog')
  assert.ok(!(await exists('blog')))
  assert.ok(!next.some((k) => k.id === 'blog'))
  assert.ok((await loadSettings()).kinds.some((k) => k.id === 'blog'))
  await kinds.removeKind('unseen')
  // Order is the writer's.
  const order = [...next].reverse()
  assert.deepEqual(
    (await kinds.saveVisibleKinds(order)).map((k) => k.id),
    order.map((k) => k.id),
  )
})

test('renaming a kind’s folder in the app keeps its settings and its notes', async () => {
  const { moved, kinds: after } = await vault.renameKindFolder('Letters', 'Correspondence')
  assert.ok(moved.some((m) => m.from === 'Letters/to-amma.md' && m.to === 'Correspondence/to-amma.md'))
  const k = after.find((x) => x.id === 'letter')!
  assert.deepEqual([k.folder, k.name, k.guidance], ['Correspondence', 'Correspondence', 'warm'])
  assert.equal((await vault.listFiles()).find((f) => f.path === 'Correspondence/to-amma.md')?.platform, 'letter')
  // Renamed by name, from Settings: the folder follows in its own style.
  const { kinds: named } = await vault.renameKindFolder('Correspondence', 'Love letters', 'Love letter')
  assert.equal(named.find((x) => x.id === 'letter')?.name, 'Love letter')
  // A case-only rename works on a case-insensitive disk too.
  await vault.renameKindFolder('Love letters', 'Love Letters')
  assert.ok((await fs.readdir(root)).includes('Love Letters'))
  assert.ok(await exists('Love Letters/to-amma.md'))
  // Never onto another kind's folder, nor a set-apart one.
  await assert.rejects(vault.renameKindFolder('Love Letters', 'Essays'), (e: Error & { status?: number }) => e.status === 409)
  await assert.rejects(vault.renameKindFolder('Love Letters', 'templates'), (e: Error & { status?: number }) => e.status === 409)
  // A subfolder is a plain rename: still its parent's kind.
  await vault.renameKindFolder('Essays/2024', 'Essays/Spring 2024')
  assert.equal((await vault.listFiles()).find((f) => f.path === 'Essays/Spring 2024/spring.md')?.platform, 'essay')
})

test('a folder renamed outside the app starts as a new kind; its old settings wait under the old name', async () => {
  await fs.rename(path.join(root, 'Book chapters'), path.join(root, 'Chapters'))
  const list = await kinds.vaultKinds()
  assert.ok(!list.some((k) => k.folder === 'Book chapters'))
  assert.equal(list.find((k) => k.folder === 'Chapters')?.name, 'Chapter')
  // Renamed back, the old kind is there again as it was.
  await fs.rename(path.join(root, 'Chapters'), path.join(root, 'Book chapters'))
  assert.equal((await kinds.vaultKinds()).find((k) => k.folder === 'Book chapters')?.id, 'book-chapter')
})

test('a kind that takes a folder keeps it: a hidden saved kind naming that folder lets go of it', async () => {
  // A kind the writer had (blog, its folder gone, settings kept), and a kind of their own in blog-posts/.
  await put('blog-posts/first.md', 'A post\n')
  const mine = (await kinds.vaultKinds()).find((k) => k.folder === 'blog-posts')!
  await kinds.saveVisibleKinds((await kinds.vaultKinds()).map((k) => (k.id === mine.id ? { ...k, guidance: 'my own blog voice' } : k)))
  assert.equal((await loadSettings()).kinds.find((k) => k.id === 'blog')?.folder, 'blog', 'the old blog kind still names blog/')
  // Renamed onto blog/: it stays the writer's kind, with its id and guidance.
  const { kinds: after } = await vault.renameKindFolder('blog-posts', 'blog')
  const k = after.find((x) => x.folder === 'blog')!
  assert.deepEqual([k.id, k.guidance], [mine.id, 'my own blog voice'])
  assert.equal((await vault.listFiles()).find((f) => f.path === 'blog/first.md')?.platform, mine.id)
  // The old one's settings wait under a free name.
  assert.equal((await loadSettings()).kinds.find((x) => x.id === 'blog')?.folder, 'blog-2')
  // Making a kind in a folder a hidden kind names does the same.
  const made = await kinds.ensureKinds([{ id: 'reviews', name: 'Review', folder: 'blog-2', guidance: '', words: 500 }])
  assert.equal(made[0].folder, 'blog-2')
  assert.equal((await kinds.vaultKinds()).find((x) => x.folder === 'blog-2')?.id, 'reviews')
  assert.equal((await loadSettings()).kinds.find((x) => x.id === 'blog')?.folder, 'blog-3')
})

test('kinds made at the same moment are all kept', async () => {
  const a = { id: 'haiku', name: 'Haiku', folder: 'haiku', guidance: 'three lines', words: 17 }
  const b = { id: 'sonnet', name: 'Sonnet', folder: 'sonnets', guidance: 'fourteen lines', words: 120 }
  await Promise.all([kinds.ensureKinds([a]), kinds.ensureKinds([b]), kinds.saveVisibleKinds(await kinds.vaultKinds())])
  const saved = (await loadSettings()).kinds
  assert.equal(saved.find((k) => k.id === 'haiku')?.guidance, 'three lines')
  assert.equal(saved.find((k) => k.id === 'sonnet')?.guidance, 'fourteen lines')
})

test('a case-only rename reports only where notes end up, and a rename never merges into a folder that is there', async () => {
  await put('Haiku-notes/one.md', 'Old pond\n')
  const { result, touched } = await vault.collectTouched(() => vault.renameKindFolder('Haiku-notes', 'haiku-notes'))
  assert.deepEqual(result.moved, [{ from: 'Haiku-notes/one.md', to: 'haiku-notes/one.md' }])
  assert.deepEqual(
    touched.map((t) => t.path),
    ['haiku-notes/one.md'],
  )
  assert.ok(!(await fs.readdir(root)).some((n) => /renaming/.test(n)), 'nothing is left in between')
  // An excluded (set-apart) folder isn't a kind, but its rename still won't merge into another folder.
  await put('archive/old.md', 'Old\n')
  await assert.rejects(vault.renameKindFolder('archive', 'haiku-notes'), (e: Error & { status?: number }) => e.status === 409)
  assert.ok(await exists('archive/old.md'))
})

test('the Brain folder is checked against the vault’s folders, not the kinds saved', async () => {
  const { saveSettings } = await import('./settings.ts')
  // An empty kind folder is still a kind.
  await fs.mkdir(path.join(root, 'Poems'), { recursive: true })
  await assert.rejects(saveSettings({ brainFolder: 'Poems' }), /Poem pieces/)
  // A folder a saved kind once named, but which isn't there, is free (texts/: the built-in Text message kind).
  assert.equal((await saveSettings({ brainFolder: 'texts' })).brainFolder, 'texts')
  // A folder of book notes (sources and nothing else) can become the Brain, though it is a folder at the top.
  await put('Reading/bird.md', '---\ntype: book\ntitle: Bird by Bird\n---\n')
  assert.equal((await saveSettings({ brainFolder: 'Reading' })).brainFolder, 'Reading')
  await saveSettings({ brainFolder: 'brain' })
})

test('renaming a kind without changing its folder only changes the name (Email → Emails, or the same name)', async () => {
  assert.ok(await exists('emails'))
  const { moved, kinds: after } = await vault.renameKindFolder('emails', 'emails', 'Mail')
  assert.deepEqual(moved, [])
  assert.equal(after.find((k) => k.id === 'email')?.name, 'Mail')
  // The same folder name from the sidebar: nothing happens, and nothing is refused.
  assert.deepEqual((await vault.renameKindFolder('emails', 'emails')).moved, [])
  assert.ok(await exists('emails'))
})

test('a kind that comes back takes its own folder again, not the one it was moved to while away', async () => {
  const { saveSettings } = await import('./settings.ts')
  const saved = (await loadSettings()).kinds.filter((k) => k.id !== 'youtube-script')
  await saveSettings({ kinds: [...saved, { id: 'youtube-script', name: 'YouTube script', folder: 'scripts-2', guidance: 'spoken', words: 900 }] })
  const back = await kinds.kindFor('youtube-script')
  assert.deepEqual([back?.folder, back?.guidance], ['scripts', 'spoken'])
  assert.ok(await exists('scripts'))
  assert.ok(!(await exists('scripts-2')))
})
