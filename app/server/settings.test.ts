// Settings against a scratch vault: kinds saved by an older version, read back as they were.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-settings-'))
process.env.EKDANTA_VAULT = root
const { loadSettings } = await import('./settings.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))

test('saved folders are kept as written: a kind is the folder on disk, so none is renamed behind the writer’s back', async () => {
  await fs.mkdir(path.join(root, '.ekdanta'), { recursive: true })
  await fs.writeFile(
    path.join(root, '.ekdanta/settings.json'),
    JSON.stringify({
      kinds: [
        { id: 'yt-scripts', name: 'YT Scripts', folder: 'yt-scriptses' },
        { id: 'captions', name: 'Captions', folder: 'captionses' },
        { id: 'letter', name: 'Letter', folder: 'letters' },
        { id: 'letters', name: 'Letters', folder: 'letterses' },
      ],
    }),
  )
  // yt-scriptses/ holds a piece, so nothing moves until the writer says so from Settings → Kinds.
  await fs.mkdir(path.join(root, 'yt-scriptses'), { recursive: true })
  await fs.writeFile(path.join(root, 'yt-scriptses/one.md'), '# one')
  // captionses/ holds only a stray .DS_Store; it is still the folder there, so it stays the Captions kind’s.
  await fs.mkdir(path.join(root, 'captionses'), { recursive: true })
  await fs.writeFile(path.join(root, 'captionses/.DS_Store'), '')
  // Settings → Kinds offers to rename a doubled folder (POST /api/kinds/rename-folder).
  const { kinds } = await loadSettings()
  assert.deepEqual(
    kinds.map((k) => `${k.id}:${k.folder}`),
    ['yt-scripts:yt-scriptses', 'captions:captionses', 'letter:letters', 'letters:letterses'],
  )
  // Names read singular either way.
  assert.deepEqual(
    kinds.map((k) => k.name),
    ['YT script', 'Caption', 'Letter', 'Letter'],
  )
})

test('the Brain folder is never one that holds the writer’s own pieces', async () => {
  const { saveSettings } = await import('./settings.ts')
  // A kind's folder, or a folder inside one, would turn its pieces into books.
  await assert.rejects(saveSettings({ brainFolder: 'letters' }), /Letter pieces/)
  await assert.rejects(saveSettings({ brainFolder: 'letters/reading' }), /Letter pieces/)
  // A folder that already holds a note that isn't a source.
  await fs.mkdir(path.join(root, 'notes/old'), { recursive: true })
  await fs.writeFile(path.join(root, 'notes/old/draft.md'), '---\ntitle: A draft\n---\nMy own words.')
  await assert.rejects(saveSettings({ brainFolder: 'notes' }), /notes\/old\/draft\.md/)
  assert.equal((await loadSettings()).brainFolder, 'brain')
  // Sources only, or nothing there yet: fine.
  await fs.mkdir(path.join(root, 'reading/books'), { recursive: true })
  await fs.writeFile(path.join(root, 'reading/books/bird.md'), '---\ntype: book\ntitle: Bird by Bird\n---\n')
  assert.equal((await saveSettings({ brainFolder: 'reading' })).brainFolder, 'reading')
  assert.equal((await saveSettings({ brainFolder: 'library' })).brainFolder, 'library')
})
