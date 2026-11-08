// Document keys for per-document files: two paths never share one, and a document whose key changed
// (its path has `_`) finds its files under the old key the first time they're used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-dockey-'))
process.env.EKDANTA_VAULT = root
const vault = await import('./vault.ts')
const v = await import('./versions.ts')
const brief = await import('./brief.ts')
const { DEFAULT_KINDS } = await import('../src/lib/kinds.ts')
const meta = path.join(root, '.ekdanta')

test.after(() => fs.rm(root, { recursive: true, force: true }))

const doc = (body: string) => `---\ntitle: T\n---\n\n${body}`
const put = async (abs: string, text: string) => {
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, text)
}
const exists = (abs: string) =>
  fs.access(abs).then(
    () => true,
    () => false,
  )
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
/** A version folder as the old code left it: one snapshot, no index (it's rebuilt from the files). */
const oldVersion = (key: string, text: string, at = '2026-11-01T10-00-00.000Z') => put(path.join(meta, 'versions', key, at + '.md'), text)
const texts = async (rel: string) => Promise.all((await v.listVersions(rel)).map((e) => v.readVersion(rel, e.id)))

test('no two paths share a key, and a path without _ keeps its old one', () => {
  const paths = ['a/b__c.md', 'a__b/c.md', 'a/b/c.md', 'a__b__c.md', 'a_b.md', 'a_-b.md', 'a/_b.md', 'a_/b.md', 'a-_b.md', '_.md', '__.md', '/.md']
  const keys = paths.map(vault.docKey)
  assert.equal(new Set(keys).size, paths.length, keys.join(' '))
  assert.equal(vault.docKey('essays/on-walking.md'), 'essays__on-walking')
  assert.equal(vault.docKey('a/b/c.md'), 'a__b__c')
  assert.equal(vault.docKey('notes/my_draft.md'), 'notes__my_-draft')
})

test('two documents that once shared a key keep their versions apart', async () => {
  await vault.writeDoc('a/b__c.md', doc('First document.'))
  await vault.writeDoc('a__b/c.md', doc('Second document.'))
  assert.deepEqual(await texts('a/b__c.md'), [doc('First document.')])
  assert.deepEqual(await texts('a__b/c.md'), [doc('Second document.')])
})

test('each kind of file kept under the old key is found the first time it is used', async () => {
  // Versions, through the version list.
  await put(path.join(root, 'notes/v_doc.md'), doc('Now.'))
  await oldVersion('notes__v_doc', doc('Earlier.'))
  assert.deepEqual(await texts('notes/v_doc.md'), [doc('Earlier.')])
  assert.ok(await exists(path.join(meta, 'versions', 'notes__v_-doc')))
  assert.equal(await exists(path.join(meta, 'versions', 'notes__v_doc')), false)

  // Ekdanta's record of its last write.
  await put(path.join(root, 'notes/w_doc.md'), doc('Saved.'))
  await put(path.join(meta, 'written', 'notes__w_doc.md'), doc('Saved.'))
  await put(path.join(meta, 'written', 'notes__w_doc.json'), JSON.stringify({ mtime: 1, hash: hash(doc('Saved.')) }))
  assert.equal((await vault.lastWritten('notes/w_doc.md'))?.body, doc('Saved.'))
  assert.equal(await exists(path.join(meta, 'written', 'notes__w_doc.json')), false)

  // A pinned brief, read directly…
  await put(path.join(root, 'notes/b_doc.md'), doc('B.'))
  await put(path.join(meta, 'briefs', 'notes__b_doc.brief.md'), 'The question.\n')
  assert.equal(await brief.readBrief('notes/b_doc.md'), 'The question.\n')
  // …and shown in the file list before the document is opened.
  await put(path.join(root, 'notes/m_doc.md'), doc('M.'))
  await put(path.join(meta, 'briefs', 'notes__m_doc.brief.md'), 'Another question.\n')
  const [marked] = await brief.markBriefs([{ path: 'notes/m_doc.md' }])
  assert.equal(marked.brief, true)

  // The help log.
  await put(path.join(root, 'notes/h_doc.md'), doc('H.'))
  await put(path.join(meta, 'history', 'notes__h_doc.jsonl'), '{"n":1}\n')
  assert.deepEqual(await vault.readHistory('notes/h_doc.md'), [{ n: 1 }])

  // The Thinking Space. (thinking.ts can't be loaded here: Node's type stripping refuses
  // claude-pool.ts. readThinking and writeThinking call adoptOldKey, then read thinkingSideFile.)
  await put(path.join(root, 'notes/t_doc.md'), doc('T.'))
  await put(path.join(meta, 'thinking', 'notes__t_doc.json'), JSON.stringify({ dismissed: ['a-b'] }))
  await vault.adoptOldKey('notes/t_doc.md')
  assert.deepEqual(JSON.parse(await fs.readFile(vault.thinkingSideFile('notes/t_doc.md'), 'utf8')), { dismissed: ['a-b'] })

  // Moving a document takes along what's still under its old key.
  await put(path.join(root, 'notes/mv_doc.md'), doc('Moving.'))
  await oldVersion('notes__mv_doc', doc('Before the move.'))
  const moved = await vault.moveToFolder(DEFAULT_KINDS, 'notes/mv_doc.md', 'elsewhere')
  assert.equal(moved, 'elsewhere/mv_doc.md')
  assert.deepEqual(await texts(moved), [doc('Before the move.')])
})

test('an old key two documents shared is left where it is, and both start fresh', async () => {
  await put(path.join(root, 'p/q__r.md'), doc('P.'))
  await put(path.join(root, 'p__q/r.md'), doc('Q.'))
  await oldVersion('p__q__r', doc('Shared.'))
  assert.deepEqual(await texts('p/q__r.md'), [])
  assert.deepEqual(await texts('p__q/r.md'), [])
  assert.ok(await exists(path.join(meta, 'versions', 'p__q__r', '2026-11-01T10-00-00.000Z.md')))
})

// a_b.md's new key a_-b is a_-b.md's old key. Each must end with only its own files, whichever is opened first.
async function twins(a: string, b: string) {
  await put(path.join(root, a + '.md'), doc('A now.'))
  await put(path.join(root, b + '.md'), doc('B now.'))
  await oldVersion(a, doc('Old A.'))
  await oldVersion(b, doc('Old B.'))
  await put(path.join(meta, 'briefs', a + '.brief.md'), 'A’s question.\n')
  await put(path.join(meta, 'briefs', b + '.brief.md'), 'B’s question.\n')
  await put(path.join(meta, 'written', b + '.md'), doc('B now.'))
  await put(path.join(meta, 'written', b + '.json'), JSON.stringify({ mtime: 1, hash: hash(doc('B now.')) }))
}
async function assertTwins(a: string, b: string) {
  assert.deepEqual(await texts(a + '.md'), [doc('Old A.')])
  assert.deepEqual(await texts(b + '.md'), [doc('Old B.')])
  assert.equal(await brief.readBrief(a + '.md'), 'A’s question.\n')
  assert.equal(await brief.readBrief(b + '.md'), 'B’s question.\n')
  assert.equal(await vault.lastWritten(a + '.md'), null)
  assert.equal((await vault.lastWritten(b + '.md'))?.body, doc('B now.'))
}

test('a new key that is another document’s old key: the other is brought over first', async () => {
  await twins('a_b', 'a_-b')
  assert.deepEqual(await texts('a_b.md'), [doc('Old A.')]) // a_b.md first
  await assertTwins('a_b', 'a_-b')
  await twins('c_d', 'c_-d')
  assert.deepEqual(await texts('c_-d.md'), [doc('Old B.')]) // c_-d.md first
  await assertTwins('c_d', 'c_-d')
  // A save and a prune on the first never touch the second's snapshots.
  await vault.writeDoc('a_b.md', doc('A saved.'))
  await v.pruneAt('a_b.md', Date.now())
  assert.deepEqual(await texts('a_-b.md'), [doc('Old B.')])
})

test('a three-link chain: each document keeps its own', async () => {
  for (const [n, k] of ['e_f', 'e_-f', 'e_--f'].entries()) {
    await put(path.join(root, k + '.md'), doc(`Now ${n}.`))
    await oldVersion(k, doc(`Old ${n}.`))
  }
  assert.deepEqual(await texts('e_f.md'), [doc('Old 0.')])
  assert.deepEqual(await texts('e_-f.md'), [doc('Old 1.')])
  assert.deepEqual(await texts('e_--f.md'), [doc('Old 2.')])
})

test('what is at a new key and can’t go to its owner is set aside, never used', async () => {
  // g__h_-i is g/h_i.md's new key, and the old key of both g/h_-i.md and g__h_-i.md: whose it is can't be told.
  await put(path.join(root, 'g/h_i.md'), doc('Mine.'))
  await put(path.join(root, 'g/h_-i.md'), doc('One.'))
  await put(path.join(root, 'g__h_-i.md'), doc('Two.'))
  await oldVersion('g__h_-i', doc('Mixed.'))
  assert.deepEqual(await texts('g/h_i.md'), [])
  assert.deepEqual(await texts('g/h_-i.md'), [])
  assert.deepEqual(await texts('g__h_-i.md'), [])
  assert.ok(await exists(path.join(meta, 'set-aside', 'versions', 'g__h_-i')))
})

test('a key in use under the new scheme is never taken as a newer document’s old key', async () => {
  // j_k.md saves under j_-k. Later a document j_-k.md appears, whose old key is j_-k: it starts empty.
  await put(path.join(root, 'j_k.md'), doc('JK.'))
  await vault.writeDoc('j_k.md', doc('JK saved.'))
  assert.ok(await exists(path.join(meta, 'keys', 'j_-k')))
  await put(path.join(root, 'j_-k.md'), doc('J-K.'))
  assert.deepEqual(await texts('j_-k.md'), [])
  assert.deepEqual(await texts('j_k.md'), [doc('JK.')])
})

test('a deep path is brought over', async () => {
  const deep = 'a1/b/c/d/e/f/g/h/i/j/k_l.md'
  await put(path.join(root, deep), doc('Deep.'))
  await oldVersion('a1__b__c__d__e__f__g__h__i__j__k_l', doc('Old deep.'))
  assert.deepEqual(await texts(deep), [doc('Old deep.')])
  // And a name full of underscores doesn't take long to check.
  const wide = 'w/' + '_'.repeat(40) + 'x.md'
  await put(path.join(root, wide), doc('Wide.'))
  await oldVersion('w__' + '_'.repeat(40) + 'x', doc('Old wide.'))
  assert.deepEqual(await texts(wide), [doc('Old wide.')])
})

test('a document moved onto a name whose keys hold old files of documents gone since takes neither', async () => {
  await put(path.join(root, 'm_n.md'), doc('Start.'))
  await vault.writeDoc('m_n.md', doc('Saved.'))
  await oldVersion('dest__m_n', doc('Old file of a dest/m_n.md, gone.')) // the new name's old key
  await oldVersion('dest__m_-n', doc('Old file of a dest__m_-n.md, gone.')) // the new name's new key
  const moved = await vault.moveToFolder(DEFAULT_KINDS, 'm_n.md', 'dest')
  assert.equal(moved, 'dest/m_n.md')
  assert.deepEqual(await texts(moved), [doc('Start.')])
  assert.ok(await exists(path.join(meta, 'versions', 'dest__m_n')))
  assert.ok(await exists(path.join(meta, 'set-aside', 'versions', 'dest__m_-n')))
})

test('a document without _ in its path is unaffected', async () => {
  await put(path.join(root, 'plain/doc.md'), doc('Plain.'))
  await oldVersion('plain__doc', doc('Old plain.'))
  await vault.adoptOldKey('plain/doc.md')
  assert.ok(await exists(path.join(meta, 'versions', 'plain__doc')))
  assert.deepEqual(await texts('plain/doc.md'), [doc('Old plain.')])
})

test('a save after the files are brought over lands at the new key', async () => {
  await put(path.join(root, 'n_doc.md'), doc('Start.'))
  await oldVersion('n_doc', doc('Old.'))
  await put(path.join(meta, 'written', 'n_doc.md'), doc('Start.'))
  await put(path.join(meta, 'written', 'n_doc.json'), JSON.stringify({ mtime: 1, hash: hash(doc('Start.')) }))
  await vault.writeDoc('n_doc.md', doc('Changed.'))
  assert.equal(await exists(path.join(meta, 'versions', 'n_doc')), false)
  assert.equal(await exists(path.join(meta, 'written', 'n_doc.md')), false)
  assert.equal(await fs.readFile(path.join(meta, 'written', 'n_-doc.md'), 'utf8'), doc('Changed.'))
  // The old version is there, and the text the save replaced was kept beside it.
  const list = await texts('n_doc.md')
  assert.equal(list[0], doc('Old.'))
  assert.ok(list.includes(doc('Start.')))
})

test('a second touch does nothing', async () => {
  await put(path.join(root, 'once_doc.md'), doc('Once.'))
  await oldVersion('once_doc', doc('Old once.'))
  assert.deepEqual(await texts('once_doc.md'), [doc('Old once.')])
  // Something appears under the old key afterwards: it isn't brought over again.
  await oldVersion('once_doc', doc('Later.'), '2026-11-02T10-00-00.000Z')
  assert.deepEqual(await texts('once_doc.md'), [doc('Old once.')])
  assert.ok(await exists(path.join(meta, 'versions', 'once_doc')))
})

test('files moved but the marker not written: after a restart they are still the document’s', async () => {
  await put(path.join(root, 'my_draft.md'), doc('Now.'))
  await oldVersion('my_draft', doc('Earlier.'))
  await put(path.join(meta, 'briefs', 'my_draft.brief.md'), 'The question.\n')
  // The marker can't be written: a file sits where its folder goes.
  await fs.rm(path.join(meta, 'keys'), { recursive: true, force: true })
  await put(path.join(meta, 'keys'), '')
  try {
    await assert.rejects(v.listVersions('my_draft.md'), /won’t use them until it’s restarted/)
  } finally {
    await fs.rm(path.join(meta, 'keys'))
  }
  assert.ok(await exists(path.join(meta, 'versions', 'my_-draft'))) // moved, marker missing
  vault.forgetAdoptions() // a restart
  assert.deepEqual(await texts('my_draft.md'), [doc('Earlier.')])
  assert.equal(await brief.readBrief('my_draft.md'), 'The question.\n')
  assert.equal(await exists(path.join(meta, 'set-aside', 'versions', 'my_-draft')), false)
  assert.ok(await exists(path.join(meta, 'keys', 'my_-draft')))
  assert.equal(await exists(path.join(meta, 'keys-pending', 'my_-draft')), false)
})

test('stopped midway through the renames: a restart finishes them and sets nothing aside', async () => {
  // As a crash leaves it: the pending marker, the versions already at the new key, the brief still at the old one.
  await put(path.join(root, 'half_way.md'), doc('Now.'))
  await oldVersion('half_-way', doc('Earlier.'))
  await put(path.join(meta, 'briefs', 'half_way.brief.md'), 'Halfway question.\n')
  await put(path.join(meta, 'keys-pending', 'half_-way'), '')
  assert.deepEqual(await texts('half_way.md'), [doc('Earlier.')])
  assert.equal(await brief.readBrief('half_way.md'), 'Halfway question.\n')
  assert.equal(await exists(path.join(meta, 'briefs', 'half_way.brief.md')), false)
  assert.equal(await exists(path.join(meta, 'set-aside', 'versions', 'half_-way')), false)
  assert.ok(await exists(path.join(meta, 'keys', 'half_-way')))
})

test('if what isn’t the document’s can’t be set aside, its files aren’t used until a restart', async () => {
  await put(path.join(root, 'q_r.md'), doc('QR.'))
  await oldVersion('q_-r', doc('Someone else’s.')) // at q_r.md's new key, owner gone
  const aside = path.join(meta, 'set-aside')
  const moved = aside + '.kept'
  await fs.rename(aside, moved).catch(() => {})
  await put(aside, '') // a file where the folder goes: setting aside fails
  try {
    await assert.rejects(v.listVersions('q_r.md'), /q_r\.md/)
    await assert.rejects(vault.lastWritten('q_r.md'), /restarted/) // every use fails, not just the first
    await assert.rejects(vault.writeDoc('q_r.md', doc('QR, typed.')), /restarted/)
    assert.equal(await fs.readFile(path.join(root, 'q_r.md'), 'utf8'), doc('QR.'))
  } finally {
    await fs.rm(aside)
    await fs.rename(moved, aside).catch(() => {})
  }
  // The other document's files are where they were, untouched.
  assert.ok(await exists(path.join(meta, 'versions', 'q_-r', '2026-11-01T10-00-00.000Z.md')))
})
