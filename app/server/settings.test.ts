// Settings against a scratch vault: how a doubled-plural folder saved by an older version is settled.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-settings-'))
process.env.EKDANTA_VAULT = root
const { loadSettings } = await import('./settings.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))

test('doubled folders are put right only when that is safe', async () => {
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
  // captionses/ holds only a stray .DS_Store, so it is corrected without asking.
  await fs.mkdir(path.join(root, 'captionses'), { recursive: true })
  await fs.writeFile(path.join(root, 'captionses/.DS_Store'), '')
  // letterses/ would be corrected to letters/, but the Letter kind already files there.
  const { kinds } = await loadSettings()
  assert.deepEqual(
    kinds.map((k) => `${k.id}:${k.folder}`),
    ['yt-scripts:yt-scriptses', 'captions:captions', 'letter:letters', 'letters:letterses'],
  )
  // Names read singular either way.
  assert.deepEqual(
    kinds.map((k) => k.name),
    ['YT script', 'Caption', 'Letter', 'Letter'],
  )
})
