import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import JSZip from 'jszip'

// A vault of its own, and a picture just outside it that no export may carry.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-export-images-'))
const vault = path.join(root, 'vault')
const outside = path.join(root, 'private.png')
process.env.EKDANTA_VAULT = vault
const { exportDoc, pandoc, canSandbox } = await import('./export.ts')
const { imageSize } = await import('./export-docx.ts')

/** A PNG of a single colour, `size` pixels square. */
function png(size: number) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])))
    return Buffer.concat([len, Buffer.from(type), data, crc])
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(size, 0)
  head.writeUInt32BE(size, 4)
  head[8] = 8
  head[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// In the vault: a 1×1 picture. Outside: a 7×7 one, also reached through a link inside the vault.
await fs.mkdir(path.join(vault, 'essays'), { recursive: true })
await fs.mkdir(path.join(vault, 'attachments'), { recursive: true })
await fs.writeFile(path.join(vault, 'attachments', 'cat (1).png'), png(1))
await fs.writeFile(outside, png(7))
await fs.symlink(outside, path.join(vault, 'attachments', 'link.png'))

const inVault = [
  '![inline](<../attachments/cat (1).png> "double")',
  "![single](<../attachments/cat (1).png> 'single')",
  '![paren](../attachments/cat%20(1).png (paren))',
  '![reference][cat]',
  `![data](data:image/png;base64,${png(1).toString('base64')})`,
]
const refused = ['![escape][private]', `![absolute](${outside} 'title')`, '![up](../../private.png)', '![symlink](../attachments/link.png)', '![web][web]']
await fs.writeFile(
  path.join(vault, 'essays', 'piece.md'),
  `# Pictures\n\n${[...inVault, ...refused].join('\n\n')}\n\n[cat]: <../attachments/cat (1).png>\n[private]: ${outside}\n[web]: https://example.com/remote.png "remote"\n`,
)

test.after(() => fs.rm(root, { recursive: true, force: true }))

/** The pictures a .docx carries, by their size, and how many places in the text show one. */
async function pictures(data: Buffer) {
  const zip = await JSZip.loadAsync(data)
  const media = await Promise.all(
    Object.values(zip.files)
      .filter((f) => !f.dir && f.name.startsWith('word/media/'))
      .map(async (f) => imageSize(await f.async('nodebuffer'))?.width),
  )
  const xml = await zip.file('word/document.xml')!.async('string')
  return { sizes: [...new Set(media)], shown: (xml.match(/<a:blip /g) ?? []).length }
}

function checkWarnings(warnings: string[]) {
  assert.ok(warnings.includes(`Image missing: ${outside}`), 'a reference or path outside the vault')
  assert.ok(warnings.includes('Image missing: ../../private.png'))
  assert.ok(warnings.includes('Image missing: ../attachments/link.png'), 'a link inside the vault to a file outside it')
  assert.ok(warnings.includes('Image on the web not embedded: https://example.com/remote.png'))
}

test('the built-in Word engine embeds the vault and data: pictures, and nothing from outside or the web', async () => {
  process.env.EKDANTA_NO_PANDOC = '1'
  try {
    const r = await exportDoc({ path: 'essays/piece.md', format: 'docx' })
    assert.equal(r.engine, 'built-in')
    const { sizes, shown } = await pictures(r.data)
    assert.deepEqual(sizes, [1])
    assert.equal(shown, inVault.length)
    checkWarnings(r.warnings)
  } finally {
    delete process.env.EKDANTA_NO_PANDOC
  }
})

test('pandoc, sandboxed, does the same', async (t) => {
  const pd = await pandoc()
  if (!pd) return t.skip('pandoc 2.15 or later is not installed')
  assert.ok(canSandbox(pd.version))
  const r = await exportDoc({ path: 'essays/piece.md', format: 'docx' })
  assert.equal(r.engine, 'pandoc')
  const { sizes, shown } = await pictures(r.data)
  assert.deepEqual(sizes, [1])
  assert.equal(shown, inVault.length)
  checkWarnings(r.warnings)
})

test('HTML carries only the vault pictures; clean Markdown links only to them', async () => {
  const html = await exportDoc({ path: 'essays/piece.md', format: 'html' })
  const one = png(1).toString('base64')
  const embedded = [...html.data.toString().matchAll(/<img src="([^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(embedded.slice(0, inVault.length), Array(inVault.length).fill(`data:image/png;base64,${one}`))
  // The web picture stays a link to the web, as a page would show it; nothing else is there.
  assert.deepEqual(embedded.slice(inVault.length), ['https://example.com/remote.png'])
  assert.doesNotMatch(html.data.toString(), new RegExp(png(7).toString('base64').slice(0, 40).replace(/[+/]/g, '\\$&')))

  const md = (await exportDoc({ path: 'essays/piece.md', format: 'md' })).data.toString()
  assert.equal((md.match(/<\.\.\/attachments\/cat%20\(1\)\.png>/g) ?? []).length, 4)
  assert.doesNotMatch(md, /!\[(escape|absolute|up|symlink)\]/)
})

test('pandoc older than 2.15 cannot be sandboxed and is not used', () => {
  assert.ok(!canSandbox('2.14.2'))
  assert.ok(!canSandbox(''))
  assert.ok(canSandbox('2.15'))
  assert.ok(canSandbox('3.10.1'))
})
