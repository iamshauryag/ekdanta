// Import: the converters on their own, then a whole batch against a scratch vault.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-import-'))
process.env.EKDANTA_VAULT = root
process.env.EKDANTA_NO_PANDOC = '1' // the built-in converters, whatever this machine has installed
const imp = await import('./index.ts')
const { sanitizeHtml, isScriptUrl, MEDIA_PREFIX } = await import('./sanitize.ts')
const { htmlToMarkdown, tidy } = await import('./html.ts')
const { decodeText, textToMarkdown, isKindleClippings } = await import('./text.ts')
const { csvToMarkdown } = await import('./csv.ts')
const { buildNote, guessPlatform, titleFromFileName, countWords } = await import('./meta.ts')
const { docxToMarkdown, docxProblem, ImportError } = await import('./docx.ts')
const vault = await import('../vault.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))
const exists = (abs: string) =>
  fs.access(abs).then(
    () => true,
    () => false,
  )

// ---- A .docx made here, so the tests need neither Word nor Pandoc ----------------------------

function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const n = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, data)
    centrals.push(central, n)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const para = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
function docx(body: string, opts: { comments?: boolean; title?: string } = {}) {
  return zip({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/styles.xml': `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
    'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    ...(opts.comments ? { 'word/comments.xml': `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="0" w:author="A">${para('Cut this?')}</w:comment></w:comments>` } : {}),
    'docProps/core.xml': `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">${opts.title ? `<dc:title>${opts.title}</dc:title>` : ''}<dcterms:created>2019-02-03T04:05:06Z</dcterms:created></cp:coreProperties>`,
  })
}

const SIMPLE = docx(para('Field Notes', 'Heading1') + para('An opening line.') + para('Things to bring', 'Heading2') + para('Pencil'))

// ---- Names and types ------------------------------------------------------------------------

test('safeName keeps only a harmless base name', () => {
  assert.equal(imp.safeName('../../etc/x.docx'), 'x.docx')
  assert.equal(imp.safeName('..%2F..%2Fevil.md'), 'evil.md')
  assert.equal(imp.safeName('/abs/path/a.md'), 'a.md')
  assert.equal(imp.safeName('C:\\Users\\me\\y.txt'), 'y.txt')
  assert.equal(imp.safeName('..'), 'file')
  assert.equal(imp.safeName('.hidden'), 'hidden')
  assert.equal(imp.safeName('a<b>:c?.txt'), 'abc.txt')
  assert.equal(imp.safeName('x'.repeat(300) + '.docx').length, 120)
})

test('cleanFolder refuses escapes, hidden folders and the inbox', () => {
  assert.equal(imp.cleanFolder(' notes / 2024/ '), 'notes/2024')
  assert.equal(imp.cleanFolder(''), '')
  assert.throws(() => imp.cleanFolder('../out'))
  assert.throws(() => imp.cleanFolder('.ekdanta'))
  assert.throws(() => imp.cleanFolder('_inbox/x'))
})

test('detectType trusts the bytes over a wrong name', () => {
  const cfb = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  assert.equal(imp.detectType('a.docx', SIMPLE), 'docx')
  assert.equal(imp.detectType('a', SIMPLE), 'docx')
  assert.equal(imp.detectType('locked.docx', cfb), 'docx') // explained by the .docx converter
  assert.equal(imp.detectType('old.doc', cfb), 'doc')
  assert.equal(imp.detectType('letter.doc', Buffer.from('{\\rtf1\\ansi hi}')), 'rtf')
  assert.equal(imp.detectType('page', Buffer.from('<!DOCTYPE html><html>')), 'html')
  assert.equal(imp.detectType('notes.txt', Buffer.from('<html> is a tag')), 'text')
  assert.equal(imp.detectType('a.TSV', Buffer.from('a\tb')), 'csv')
  assert.equal(imp.detectType('a.pdf', Buffer.from('%PDF-1.4')), 'other')
})

// ---- Sanitising HTML ------------------------------------------------------------------------

test('sanitizeHtml removes scripts, handlers and script links; data: images become media', () => {
  const s = sanitizeHtml(
    '<p onclick="x()">Hi <a href="javascript:alert(1)">bad</a> <a href=" JaVaScRiPt:alert(1)">bad2</a> <a href="vbscript:x">vb</a> <a href="https://ok.example">ok</a></p><script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe><object data="x"></object><img src="data:image/png;base64,iVBORw0KGgo=" onerror="x()"><img src="data:image/svg+xml;base64,PHN2Zz4=">',
    'pic',
  )
  assert.doesNotMatch(s.html, /script|onclick|onerror|iframe|object|<style|javascript|vbscript|svg/i)
  assert.match(s.html, /bad/) // the text stays, the link goes
  assert.match(s.html, /href="https:\/\/ok\.example"/)
  assert.equal(s.media.length, 1)
  assert.equal(s.media[0].name, 'pic-1.png')
  assert.match(s.html, new RegExp(`src="${MEDIA_PREFIX}pic-1.png"`))
  assert.ok(isScriptUrl('java\tscript:alert(1)'))
  assert.ok(isScriptUrl('data:text/html,<script>'))
  assert.ok(!isScriptUrl('data:image/png;base64,AAAA'))
  assert.ok(!isScriptUrl('https://example.com/javascript:'))
})

test('HTML articles keep headings and lose the site around them', () => {
  const page = `<!doctype html><html><head><title>Slow Mornings | The Blog</title><meta property="article:published_time" content="2021-05-04T10:00:00Z"></head><body>
    <nav><a href="/">Home</a> <a href="/about">About this site</a></nav><script>alert('x')</script>
    <article><h1>Slow Mornings</h1><p>${'A long first paragraph about mornings and coffee and light. '.repeat(6)}</p>
    <h2>Coffee first</h2><p>${'The kettle, the cup, the quiet before anyone else is up. '.repeat(5)}<a href="javascript:alert(1)">click</a></p></article>
    <footer>Copyright footer text</footer></body></html>`
  const out = htmlToMarkdown(page, { article: true })
  assert.match(out.markdown, /^## Coffee first$/m)
  assert.doesNotMatch(out.markdown, /About this site|Copyright footer|alert|javascript/)
  assert.equal(out.title, 'Slow Mornings')
  assert.equal(out.created, '2021-05-04')
})

test('list markers are followed by one plain space', () => {
  assert.equal(tidy('-   a\n1.\u00a0\u00a0b\n-\u00a0c\n```\n-   code\n```\n'), '- a\n1. b\n- c\n```\n-   code\n```\n')
})

test('a table with merged cells stays an HTML table; a plain one becomes Markdown', () => {
  const merged = htmlToMarkdown('<table><tr><td colspan="2" style="width:9in" class="x">Both</td></tr><tr><td>a</td><td>b</td></tr></table>')
  assert.match(merged.markdown, /<table><tbody><tr><td colspan="2">Both<\/td><\/tr>/)
  assert.ok(merged.notes.some((n) => /merged/.test(n)))
  // A heading row doesn't make it a Markdown table either.
  const headed = htmlToMarkdown('<table><colgroup><col></colgroup><thead><tr><th colspan="2">Both</th></tr></thead><tr><td>a</td><td>b</td></tr></table>')
  assert.match(headed.markdown, /^<table><thead><tr><th colspan="2">Both<\/th><\/tr><\/thead>/m)
  // Word's paragraphs inside cells become line breaks, so the cell stays on one line.
  const plain = htmlToMarkdown('<table><tr><td><p>Name</p></td><td>City</td></tr><tr><td><p>Asha</p><p>Rao</p></td><td>Pune</td></tr></table>')
  assert.match(plain.markdown, /^\| Asha<br>Rao \| Pune \|$/m)
  assert.match(plain.markdown, /^\| Name \| City \|$/m)
})

// ---- Text ---------------------------------------------------------------------------------------

test('decodeText reads Windows-1252, UTF-16 and UTF-8 with or without a BOM', () => {
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])).text, 'café')
  assert.equal(decodeText(Buffer.from('Ma\u00f1ana \u201cquoted\u201d', 'latin1').subarray(0, 7)).text, 'Mañana ')
  assert.equal(decodeText(Buffer.from([0x93, 0x68, 0x69, 0x94])).text, '\u201chi\u201d') // smart quotes in 1252
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('café', 'utf16le')])).text, 'café')
  assert.equal(decodeText(Buffer.from('plain words here', 'utf16le')).text, 'plain words here')
  const be = Buffer.from('ok', 'utf16le').swap16()
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text, 'ok')
  assert.equal(decodeText(Buffer.from('\ufeffcafé', 'utf8')).text, 'café')
  assert.equal(decodeText(Buffer.from('naïve 日本', 'utf8')).encoding, 'utf-8')
})

test('textToMarkdown reflows hard wraps, converts Setext headings, keeps short lines', () => {
  const md = textToMarkdown(
    'Title\r\n=====\r\n\r\nThis is a long hard-wrapped line that goes on until the seventy\r\ncharacter mark, where the old editor broke it onto the next\r\nline.\r\n\r\nPart two\r\n--------\r\nRoses are red\r\nViolets blue\r\n\r\n- one\r\n- two\r\n',
  )
  assert.equal(
    md,
    '# Title\n\nThis is a long hard-wrapped line that goes on until the seventy character mark, where the old editor broke it onto the next line.\n\n## Part two\n\nRoses are red\\\nViolets blue\n\n- one\n- two\n',
  )
  // A rule under a list isn't a heading.
  assert.doesNotMatch(textToMarkdown('- a\n---\n'), /^## /m)
})

test('Kindle clippings are recognised', () => {
  const clip = 'Book (Author)\n- Your Highlight on page 3 | Added on Monday\n\nA line\n==========\nBook (Author)\n- Your Note on page 4\n\nx\n==========\n'
  assert.ok(isKindleClippings('clips.txt', clip))
  assert.ok(isKindleClippings('My Clippings.txt', 'anything'))
  assert.ok(!isKindleClippings('notes.txt', 'just notes'))
})

// ---- CSV ----------------------------------------------------------------------------------------

test('csvToMarkdown makes a GFM table, escapes pipes, and caps long files', () => {
  const t = csvToMarkdown('name,note\nAsha,"a | b"\nBen,"two\nlines"\n')
  assert.equal(t.markdown, '| name | note |\n| --- | --- |\n| Asha | a \\| b |\n| Ben | two<br>lines |\n')
  const rows = ['n'].concat(Array.from({ length: 12 }, (_, i) => String(i))).join('\n')
  const capped = csvToMarkdown(rows, { maxRows: 10, attachment: 'ekdanta-media:big.csv' })
  assert.equal(capped.dropped, 2)
  assert.equal(capped.markdown.split('\n').filter((l) => l.startsWith('| ')).length, 12) // head, rule, 10 rows
  assert.match(capped.markdown, /2 more rows are in \[the full file\]\(ekdanta-media:big\.csv\)/)
  assert.equal(csvToMarkdown('').markdown, '')
})

// ---- Front matter -------------------------------------------------------------------------------

test('guessPlatform only guesses kinds the writer has', () => {
  const kinds = ['essay', 'linkedin', 'email']
  assert.equal(guessPlatform('Big news today. Hiring!\n\n#hiring #writing', kinds), 'linkedin')
  assert.equal(guessPlatform('Big news today.\n\n#hiring', ['essay']), undefined)
  assert.equal(guessPlatform('# Heading\n\nDear Priya,\n\nThanks.', kinds), 'email')
  assert.equal(guessPlatform('Hi all\n\nQuick one.', kinds), 'email')
  assert.equal(guessPlatform('Hi there. This is an essay that starts oddly and goes on.', kinds), undefined)
  assert.equal(guessPlatform('Hiking in May was lovely.', kinds), undefined)
  assert.equal(guessPlatform('hello\n\nworld', kinds), undefined)
  assert.equal(guessPlatform(`${'word '.repeat(400)} #tag`, kinds), undefined) // too long for a post
})

test('buildNote writes the front matter and drops a heading that repeats the title', () => {
  const note = buildNote('# Field Notes\n\nText.\n', { title: 'Field Notes', created: '2019-02-03', imported: '2026-11-06', source: 'a.docx' })
  assert.equal(note, '---\ntitle: Field Notes\ncreated: 2019-02-03\nimported: 2026-11-06\nsource: a.docx\nstatus: imported\n---\n\nText.\n')
  const md = buildNote('---\ntitle: Mine\ntags:\n  - a\nstatus: draft\n---\n\nBody\n', { title: 'X', created: '2020-01-01', imported: '2026-11-06', source: 'm.md', platform: 'essay' })
  assert.match(md, /^title: Mine$/m)
  assert.match(md, /^status: draft$/m)
  assert.match(md, /^ {2}- a$/m)
  assert.match(md, /^platform: essay$/m)
  assert.match(md, /^source: m\.md$/m)
  assert.equal(titleFromFileName('my_draft-final.docx'), 'My draft final')
  assert.equal(countWords('# Hi\n\nOne two [three](http://x.y/z) ![pic](a.png)'), 4)
})

// ---- Word -----------------------------------------------------------------------------------------

test('docx (built-in): headings, accepted changes, comments noted, properties read', async () => {
  const buf = docx(
    para('Field Notes', 'Heading1') +
      `<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:ins w:id="1" w:author="A"><w:r><w:t>inserted</w:t></w:r></w:ins><w:del w:id="2" w:author="A"><w:r><w:delText>deleted</w:delText></w:r></w:del></w:p>` +
      para('Things to bring', 'Heading2'),
    { comments: true, title: 'From Properties' },
  )
  const out = await docxToMarkdown(buf, 'x.docx', { pandoc: null, work: root, prefix: 'x' })
  assert.match(out.markdown, /^# Field Notes$/m)
  assert.match(out.markdown, /^## Things to bring$/m)
  assert.match(out.markdown, /Kept inserted/)
  assert.doesNotMatch(out.markdown, /deleted|Cut this/)
  assert.ok(out.notes.some((n) => /comment was left out/.test(n)))
  assert.ok(out.notes.some((n) => /Tracked changes were accepted/.test(n)))
  assert.equal(out.title, 'From Properties')
  assert.equal(out.created, '2019-02-03')
})

test('docx: password-protected and damaged files fail with a reason', async () => {
  const locked = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64), Buffer.from('EncryptionInfo', 'utf16le')])
  assert.match(docxProblem(locked)!, /password-protected/)
  assert.match(docxProblem(Buffer.from('PK\x03\x04 nonsense'))!, /damaged/)
  assert.match(docxProblem(zip({ 'a.txt': 'x' }))!, /not a Word document/)
  assert.equal(docxProblem(SIMPLE), null)
  await assert.rejects(docxToMarkdown(locked, 'x.docx', { pandoc: null, work: root, prefix: 'x' }), ImportError)
})

// ---- A whole import, against the scratch vault -----------------------------------------------

async function upload(batch: string, name: string, data: Buffer | string) {
  return imp.addUpload(batch, name, Date.UTC(2020, 0, 2), [Buffer.from(data)])
}

test('an import batch: inbox, uploads, failures, duplicates, collisions, undo', async () => {
  await fs.mkdir(path.join(root, '_inbox'), { recursive: true })
  await fs.writeFile(path.join(root, '_inbox', 'Field.docx'), SIMPLE)
  await fs.writeFile(path.join(root, '_inbox', '.DS_Store'), 'x')
  await vault.writeDoc('imported/field-notes.md', '---\ntitle: Taken\n---\n\nAlready here.\n') // forces -2

  const b = await imp.openBatch()
  assert.equal(b.pandoc, false)
  assert.deepEqual(
    b.items.map((i) => [i.name, i.status, i.inbox]),
    [['Field.docx', 'pending', '_inbox/Field.docx']],
  )
  const docxItem = await imp.convert(b.batch, b.items[0].id)
  assert.equal(docxItem.status, 'converted')
  assert.equal(docxItem.converter, 'built-in')
  assert.equal(docxItem.title, 'Field Notes')
  assert.equal(docxItem.created, '2019-02-03')

  const evil = await upload(b.batch, '../../evil.md', '# Evil\n\nhello')
  assert.equal(evil.name, 'evil.md')
  assert.ok(await exists(path.join(root, '.ekdanta/import', b.batch, 'originals/evil.md')))
  assert.ok(!(await exists(path.join(root, 'evil.md'))))
  const broken = await upload(b.batch, 'broken.docx', 'PK\x03\x04 nope')
  assert.equal(broken.status, 'failed')
  assert.match(broken.reason!, /damaged/)
  const twin = await upload(b.batch, 'copy.docx', SIMPLE)
  assert.equal(twin.status, 'duplicate')
  const odd = await upload(b.batch, 'data.bin', Buffer.from([1, 2, 3]))
  assert.equal(odd.status, 'unsupported')
  assert.equal(odd.reason, 'Unsupported type')

  // Nothing is in the vault until it's imported, and the inbox file stays put.
  assert.ok(await exists(path.join(root, '_inbox/Field.docx')))
  await assert.rejects(imp.commit(b.batch, broken.id, {}), /damaged/)
  await assert.rejects(imp.commit(b.batch, evil.id, { folder: '../x' }), /can’t be used/)

  const done = await imp.commit(b.batch, docxItem.id, { platform: 'essay', folder: 'imported' })
  assert.equal(done.imported?.path, 'imported/field-notes-2.md')
  const text = await fs.readFile(path.join(root, 'imported/field-notes-2.md'), 'utf8')
  assert.match(text, /^title: Field Notes$/m)
  assert.match(text, /^created: 2019-02-03$/m)
  assert.match(text, /^source: Field\.docx$/m)
  assert.match(text, /^platform: essay$/m)
  assert.match(text, /^## Things to bring$/m)
  assert.ok(!(await exists(path.join(root, '_inbox/Field.docx'))), 'the inbox file left the inbox')
  const att = await imp.commit(b.batch, odd.id, { folder: 'imported' })
  const attText = await fs.readFile(path.join(root, att.imported!.path), 'utf8')
  assert.match(attText, /\[data\.bin\]\(\.\.\/attachments\/data\/data\.bin\)/)
  assert.ok(await exists(path.join(root, 'attachments/data/data.bin')))
  // Committing twice does nothing more.
  assert.equal((await imp.commit(b.batch, docxItem.id, {})).imported?.path, 'imported/field-notes-2.md')

  // The same file in a later batch: already imported.
  const b2 = await imp.openBatch()
  assert.equal(b2.items.length, 0)
  const again = await upload(b2.batch, 'Field.docx', SIMPLE)
  assert.equal(again.status, 'duplicate')
  assert.match(again.reason!, /imported\/field-notes-2\.md/)

  // Undo: untouched notes go, edited ones go to Recently deleted, inbox files come back.
  await fs.appendFile(path.join(root, att.imported!.path), '\nMy own words.\n')
  const undone = await imp.undo(b.batch)
  assert.deepEqual(undone.removed.sort(), ['imported/data.md', 'imported/field-notes-2.md'])
  assert.deepEqual(undone.trashed, ['imported/data.md'])
  assert.deepEqual(undone.missing, [])
  assert.ok(!(await exists(path.join(root, 'imported/field-notes-2.md'))))
  assert.ok(await exists(path.join(root, 'attachments/data/data.bin')), 'the edited note keeps its attachment')
  assert.ok(await exists(path.join(root, '_inbox/Field.docx')), 'back in the inbox')
  assert.ok((await vault.listTrash()).some((t) => t.path === 'imported/data.md'))
  assert.ok(await exists(path.join(root, 'imported/field-notes.md')), 'the writer’s own note is untouched')
  // After an undo it's no longer a duplicate.
  assert.equal((await imp.convert(b2.batch, again.id)).status, 'converted')
})

test('undo removes attachments only with an untouched note; edited and renamed notes keep theirs', async () => {
  const b = await imp.openBatch()
  const [same, edited, renamed] = await Promise.all(['same.bin', 'edited.bin', 'renamed.bin'].map((name, i) => upload(b.batch, name, Buffer.from([9, 9, i]))))
  const note = async (id: string) => (await imp.commit(b.batch, id, { folder: 'undo-test' })).imported!
  const [s, e, r] = [await note(same.id), await note(edited.id), await note(renamed.id)]
  for (const done of [s, e, r]) assert.equal(done.media.length, 1)
  // The link in a note resolves, relative to the note's folder, to its attachment.
  const linked = async (rel: string) => {
    const target = (await fs.readFile(path.join(root, rel), 'utf8')).match(/\]\(([^)]+)\)/)![1]
    return exists(path.join(root, path.posix.dirname(rel), decodeURIComponent(target)))
  }
  for (const done of [s, e, r]) assert.ok(await linked(done.path))

  await fs.appendFile(path.join(root, e.path), '\nMy own words.\n')
  await fs.rename(path.join(root, r.path), path.join(root, 'undo-test/my-name.md'))
  const undone = await imp.undo(b.batch)
  assert.deepEqual(undone.removed.sort(), [s.path, e.path].sort())
  assert.deepEqual(undone.trashed, [e.path])
  assert.deepEqual(undone.missing, [r.path])

  // Untouched: the note and its attachments are gone, folder and all.
  assert.ok(!(await exists(path.join(root, s.path))))
  assert.ok(!(await exists(path.join(root, path.posix.dirname(s.media[0])))))
  // Edited: in Recently deleted, and restoring it brings back a note whose picture still shows.
  assert.ok(!(await exists(path.join(root, e.path))))
  assert.ok(await exists(path.join(root, e.media[0])))
  const trashed = (await vault.listTrash()).find((t) => t.path === e.path)!
  const restored = await vault.restoreDoc(trashed.id)
  assert.equal(restored, e.path)
  assert.match(await fs.readFile(path.join(root, restored), 'utf8'), /My own words/)
  assert.ok(await linked(restored))
  // Renamed: left alone, and its link still works.
  assert.ok(await exists(path.join(root, r.media[0])))
  assert.ok(await linked('undo-test/my-name.md'))
})

test('a title spanning lines becomes one line, and the front matter stays valid', async () => {
  const b = await imp.openBatch()
  const item = await upload(b.batch, 'lines.docx', docx(para('Just a paragraph, no heading.'), { title: 'Two\n   Lines' }))
  assert.equal(item.title, 'Two Lines')
  const done = await imp.commit(b.batch, item.id, { folder: 'undo-test' })
  assert.match(await fs.readFile(path.join(root, done.imported!.path), 'utf8'), /^title: Two Lines$/m)
})

test('openBatch refuses a bad batch id and unknown rows', async () => {
  await assert.rejects(imp.convert('../../etc', 'x'), /No such import/)
  const b = await imp.openBatch()
  await assert.rejects(imp.convert(b.batch, 'nope'), /No such file/)
  await assert.rejects(imp.preview(b.batch, '../x'), /No such file/)
})

test('the sample vault goes only into an empty vault', async () => {
  const sample = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-sample-'))
  await fs.mkdir(path.join(sample, 'essays'))
  await fs.writeFile(path.join(sample, 'essays/a.md'), '# A\n')
  await fs.mkdir(path.join(sample, '.ekdanta'))
  await assert.rejects(vault.copySampleVault(sample), /isn’t empty/)
  await fs.rm(sample, { recursive: true, force: true })
})
