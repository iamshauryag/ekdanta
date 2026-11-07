// Front matter through the real save path: the page's Saver, joinDoc, and the vault's writeDoc on a
// scratch vault. Editing the body must never touch the front matter's bytes, least of all front matter
// Ekdanta can't model (read-only), which is shown but never rewritten.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-docsave-'))
process.env.EKDANTA_VAULT = root
const vault = await import('./vault.ts')
const { Saver } = await import('../src/lib/saver.ts')
const { joinDoc, joinFrontMatter, patchContent, patchFrontMatter, splitFrontMatter } = await import('../src/lib/frontmatter.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))

/** Open `rel` as the app does, type `edit` at the end of its body, and save it through a Saver into the vault. */
async function editAndSave(rel: string, edit: string) {
  const disk = await vault.readWithMtime(rel)
  assert.ok(disk)
  // As App.tsx opens a page: the whole front matter is kept on the document, and the Saver is given the text.
  const doc = { ...splitFrontMatter(disk.content), path: rel }
  const saver = new Saver({
    write: (p, content, opts) => vault.writeDoc(p, content, opts),
    // App.tsx's content(): the file's text is always joinDoc of the open document.
    content: () => ({ path: doc.path, content: joinDoc(doc) }),
    onState: () => {},
    onConflict: (c) => assert.fail('unexpected conflict: ' + c.content),
    onGone: (p) => assert.fail('unexpected gone: ' + p),
    store: null,
    delay: 60_000,
  })
  saver.open(rel, disk.mtime, disk.content)
  // As the editor's onChange does.
  doc.body = doc.body + edit
  saver.edited()
  assert.equal(await saver.flush(), true, 'the save landed')
  saver.close()
  return { before: disk.content, after: await fs.readFile(path.join(root, rel), 'utf8'), doc }
}

const READONLY: [string, string][] = [
  ['nested.md', '---\nauthor:\n  name: Ann\n  site: x\ntitle: Nested\n---\n\nThe body.\n'],
  ['block-text.md', '---\nsummary: |\n  two\n  lines\nstatus: draft\n---\nNo blank line after the fence.\n'],
  ['crlf-bom.md', '﻿---\r\nx:\r\n  y: 1\r\ntitle: "Windows"\r\n---\r\n\r\nLine one.\r\nLine two.\r\n'],
  ['unclosed.md', '---\ntitle: "unclosed\n# a comment\nstatus: draft\n---\n\nBody\n'],
]

test('read-only front matter comes back byte for byte after the body is edited and saved', async () => {
  for (const [rel, content] of READONLY) {
    await fs.writeFile(path.join(root, rel), content)
    const fm = splitFrontMatter(content)
    assert.equal(fm.readonly, true, rel + ' is read-only')
    const { after } = await editAndSave(rel, 'Added.\n')
    // The whole file, byte for byte: the front matter as it was (BOM, line endings, fences, the blank
    // line or none), and the body with the edit in the file's own line endings.
    assert.equal(after, content + 'Added.' + fm.eol, rel)
    assert.ok(after.startsWith(fm.head), rel + ': the front matter is untouched')
    assert.equal(splitFrontMatter(after).readonly, true)
  }
})

test('the read-only check would catch a rewrite', () => {
  // The old way of writing a document back (raw, meta and body alone) loses the BOM and line endings:
  // if the save path ever went back to it, the test above would fail.
  const [, content] = READONLY[2]
  const fm = splitFrontMatter(content)
  const rewritten = joinFrontMatter(fm.raw, fm.meta, fm.body)
  assert.notEqual(rewritten, content)
  assert.ok(!rewritten.startsWith(fm.head))
})

test('a change to read-only front matter is refused, never written', async () => {
  for (const [rel] of READONLY) {
    const before = await fs.readFile(path.join(root, rel), 'utf8')
    // The open page (setMeta) and a page that isn't open (POST /api/meta) both leave it alone.
    const fm = splitFrontMatter(before)
    assert.equal(joinDoc(patchFrontMatter(fm, { exemplar: 'true', title: 'Changed' })), before)
    assert.equal(patchContent(before, { exemplar: 'true' }), before)
    await assert.rejects(vault.editableFrontMatter(rel, 'star'), /can't be edited/)
    assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), before)
  }
})

test('ordinary front matter keeps its order, quoting and comments when the body is saved', async () => {
  const content = [
    '---',
    '# kept by hand: newest first',
    'zeta: last-alphabetically',
    "status: 'draft'",
    'title: "On: being edited"',
    'tags: [craft, "slow writing"]',
    'aliases:',
    '    - Being edited',
    '    - "Edited, being"',
    '',
    'created: 2026-01-02',
    'exemplar: true',
    '---',
    '',
    'Body text.',
    '',
  ].join('\n')
  await fs.writeFile(path.join(root, 'ordinary.md'), content)
  const fm = splitFrontMatter(content)
  assert.equal(fm.readonly, false)
  assert.equal(fm.meta.title, 'On: being edited')
  const { after } = await editAndSave('ordinary.md', 'More text.\n')
  assert.equal(after, content + 'More text.\n')
  // A real change touches only its own line.
  const starred = patchContent(after, { exemplar: null, status: 'ready' })
  assert.equal(starred, after.replace("status: 'draft'", 'status: ready').replace('exemplar: true\n', ''))
})
