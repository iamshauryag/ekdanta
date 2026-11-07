// The Brain rewrites source notes when it adds a highlight or imports some. Only the body may change:
// front matter Ekdanta can't model (read-only), a BOM and CRLF line endings come back byte for byte.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-brain-docsave-'))
process.env.EKDANTA_VAULT = root
const vault = await import('./vault.ts')
const brain = await import('./brain.ts')
const { splitFrontMatter } = await import('../src/lib/frontmatter.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))

const NESTED = '---\ntype: book\ntitle: Nested\nauthor: Ann Writer\nextra:\n  shelf: 3\n---\n\n## Highlights\n'
const CRLF = '﻿---\r\ntype: book\r\ntitle: "Windows"\r\nauthor: Bo Writer\r\n---\r\n\r\n## Highlights\r\n'

async function put(rel: string, content: string) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), content)
}

test('adding a highlight leaves the front matter exactly as it was, and reports the write', async () => {
  for (const [rel, content] of [
    ['brain/books/nested.md', NESTED],
    ['brain/books/windows.md', CRLF],
  ] as const) {
    await put(rel, content)
    const head = splitFrontMatter(content).head
    const { result, touched } = await vault.collectTouched(() => brain.addHighlight(rel, 'A line worth keeping.', 'loc 12'))
    assert.equal(result.added, 1, rel)
    const after = await fs.readFile(path.join(root, rel), 'utf8')
    assert.ok(after.startsWith(head), rel + ': the front matter is untouched')
    assert.match(after, /A line worth keeping\./)
    if (content.includes('\r\n')) assert.ok(!/[^\r]\n/.test(after), rel + ': still CRLF throughout')
    assert.deepEqual(
      touched.map((t) => t.path),
      [rel],
      rel + ': the open document can take the change in',
    )
  }
})

test('an import into a known book leaves its front matter alone', async () => {
  const rel = 'brain/books/nested.md'
  const head = splitFrontMatter(await fs.readFile(path.join(root, rel), 'utf8')).head
  const csv = 'Highlight,Book Title,Book Author,Amazon Book ID,Note,Color,Tags,Location Type,Location,Highlighted at,Document tags\n"Another line.",Nested,Ann Writer,,,,,location,40,,\n'
  const { result, touched } = await vault.collectTouched(() => brain.runImport(csv, 'readwise.csv'))
  assert.equal(result.created, 0)
  assert.deepEqual(result.changed, [rel])
  assert.ok(touched.some((t) => t.path === rel))
  const after = await fs.readFile(path.join(root, rel), 'utf8')
  assert.ok(after.startsWith(head))
  assert.match(after, /Another line\./)
})
