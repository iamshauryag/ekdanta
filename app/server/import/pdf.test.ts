// PDF import: the layout rules on made-up lines, then real PDFs written here (no fixtures, no tools),
// read through the worker, and one imported with labels into a scratch vault.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-pdf-'))
process.env.EKDANTA_VAULT = root
const imp = await import('./index.ts')
const { pdfToMarkdown } = await import('./pdf.ts')
const { ImportError } = await import('./docx.ts')
const { join, escapeMd, cleanTitle, pdfDate, layoutPages } = await import('./pdf-layout.ts')
const { buildNote, cleanLabels } = await import('./meta.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))

// ---- A PDF written by hand: Helvetica text at given positions, optional pictures and info ---------

interface PageSpec {
  /** Text runs: x, y from the bottom of the page, size, text. */
  text?: [number, number, number, string][]
  /** Draw a picture across the page (a "scan"). */
  picture?: boolean
}

function pdf(pages: PageSpec[], opts: { info?: string; encrypt?: boolean } = {}): Buffer {
  const objs: string[] = []
  const add = (s: string) => objs.push(s)
  add('') // 1: catalog
  add('') // 2: pages
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const pictures = pages.some((p) => p.picture)
  const image = pictures ? add('<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n\xff\x00\x00\xff\nendstream') : 0
  const kids: number[] = []
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&')
  for (const p of pages) {
    const ops = [...(p.picture ? ['q 512 0 0 692 50 50 cm /Im1 Do Q'] : []), ...(p.text ?? []).map(([x, y, size, s]) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET`)].join('\n')
    const content = add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >>${image ? ` /XObject << /Im1 ${image} 0 R >>` : ''} >> /Contents ${content} 0 R >>`))
  }
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  const info = opts.info ? add(opts.info) : 0
  const hex = (n: number, seed: number) => Array.from({ length: n }, (_, i) => ((i * 37 + seed) & 255).toString(16).padStart(2, '0')).join('')
  const encrypt = opts.encrypt ? add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${hex(32, 1)}> /U <${hex(32, 2)}> >>`) : 0
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  const extra = (info ? ` /Info ${info} 0 R` : '') + (encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${hex(16, 3)}> <${hex(16, 3)}>]` : '')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${extra} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Lines down the page from `top`, `pitch` apart, starting at x. */
const lines = (x: number, top: number, size: number, texts: string[], pitch = size * 1.3): [number, number, number, string][] => texts.map((t, i) => [x, top - i * pitch, size, t])

/** A page of a short book: running header, page number, and body text. */
function bookPage(n: number, body: [number, number, number, string][]): PageSpec {
  return { text: [[72, 760, 9, 'The Quiet Draft  -  Notes on Writing'], ...body, [300, 36, 9, String(n)]] }
}

// ---- Layout rules -------------------------------------------------------------------------------

test('join mends words broken at a line end, unless the text spells them with a hyphen', () => {
  assert.equal(join('a long-', 'winded thing'), 'a longwinded thing')
  assert.equal(join('the self-', 'esteem of', new Set(['self-esteem'])), 'the self-esteem of')
  assert.equal(join('North-', 'East'), 'North- East') // a capital after the hyphen: not a broken word
  assert.equal(join('soft­', 'ware'), 'software')
  assert.equal(join('and then—', 'nothing'), 'and then—nothing')
  assert.equal(join('one', 'two'), 'one two')
})

test('escapeMd keeps PDF text from turning into Markdown', () => {
  assert.equal(escapeMd('a *b* _c_ [d] `e` <div> 3 < 4'), 'a \\*b\\* \\_c\\_ \\[d\\] \\`e\\` \\<div> 3 < 4')
  const out = layoutPages([{ width: 612, height: 792, items: [{ str: '# not a heading', x: 72, y: 100, w: 80, size: 11 }] }])
  assert.equal(out.markdown, '\\# not a heading\n')
})

test('PDF titles and dates: program-made titles are ignored; dates are read as written', () => {
  assert.equal(cleanTitle('  The Quiet   Draft '), 'The Quiet Draft')
  assert.equal(cleanTitle('Microsoft Word - draft.docx'), undefined)
  assert.equal(cleanTitle('untitled'), undefined)
  assert.equal(cleanTitle('report-final.pdf'), undefined)
  assert.equal(pdfDate("D:20190203040506+05'30'"), '2019-02-03')
  assert.equal(pdfDate('D:2019'), '2019-01-01')
  assert.equal(pdfDate('D:00000000'), undefined)
  assert.equal(pdfDate(undefined), undefined)
})

test('cleanLabels makes tags of what was typed; buildNote adds them to the source’s own', () => {
  assert.deepEqual(cleanLabels(['#Craft', 'craft', ' long form ', 'a:b', '2024', 'writing//notes/', 7, '']), ['Craft', 'long-form', 'ab', 'writing/notes'])
  assert.deepEqual(cleanLabels('nope'), [])
  const meta = { title: 'T', created: '2020-01-01', imported: '2026-01-01', source: 'a.md' }
  const note = buildNote('---\ntags: [old]\n---\n\nBody\n', { ...meta, tags: ['new', 'OLD'] })
  assert.match(note, /^tags: \[old, new\]$/m)
  assert.match(buildNote('Body\n', { ...meta, tags: ['one', 'two'] }), /^tags:\n {2}- one\n {2}- two$/m)
  assert.doesNotMatch(buildNote('Body\n', meta), /tags/)
})

// ---- Real PDFs through the worker ---------------------------------------------------------------

test('paragraphs, broken words, headings, running headers and page numbers, metadata', async () => {
  const p1 = bookPage(1, [
    [72, 700, 22, 'Why Slow Writing Matters'],
    [72, 660, 15, 'The first draft'],
    ...lines(72, 630, 11, ['Every draft starts as a mess, and that is fine. The mess is where the thinking hap-', 'pens, slowly, one sentence at a time, until the shape of the piece shows itself.']),
    ...lines(90, 590, 11, ['A new paragraph starts with an indent. It runs on for a while and then', 'stops right here.']),
    ...lines(72, 540, 11, ['After a gap, another paragraph, which carries on to the bottom of the page and']),
  ])
  const p2 = bookPage(2, [...lines(72, 700, 11, ['continues on the next one without a break.']), [72, 660, 15, 'Revising'], ...lines(72, 630, 11, ['Cut what does not serve the reader.'])])
  const p3 = bookPage(3, [...lines(72, 700, 11, ['The end.'])])
  const out = await pdfToMarkdown(pdf([p1, p2, p3], { info: '<< /Title (Slow Writing) /CreationDate (D:20210304050607Z) >>' }))
  assert.equal(out.title, 'Slow Writing')
  assert.equal(out.created, '2021-03-04')
  assert.deepEqual(out.notes, [])
  assert.equal(
    out.markdown,
    [
      '# Why Slow Writing Matters',
      '## The first draft',
      'Every draft starts as a mess, and that is fine. The mess is where the thinking happens, slowly, one sentence at a time, until the shape of the piece shows itself.',
      'A new paragraph starts with an indent. It runs on for a while and then stops right here.',
      'After a gap, another paragraph, which carries on to the bottom of the page and continues on the next one without a break.',
      '## Revising',
      'Cut what does not serve the reader.',
      'The end.',
    ].join('\n\n') + '\n',
  )
  assert.doesNotMatch(out.markdown, /Quiet Draft/)
})

test('lists keep their items, and a numbered line mid-sentence stays in the sentence', async () => {
  const out = await pdfToMarkdown(
    pdf([
      {
        text: [
          // \x95 is the bullet in Helvetica's WinAnsi encoding.
          ...lines(72, 700, 11, ['Things to bring:', '\x95 A pencil', '\x95 Paper that is good enough to write a long item on, with a']),
          [80, 700 - 3 * 14.3, 11, 'second line'],
          ...lines(72, 700 - 4 * 14.3, 11, ['1. First step', '2. Second step']),
          ...lines(72, 600, 11, ['The method is described in chapter', '3. It works well.']),
        ],
      },
    ]),
  )
  assert.match(out.markdown, /^Things to bring:\n\n- A pencil\n- Paper that is good enough to write a long item on, with a second line\n1\. First step\n2\. Second step$/m)
  assert.match(out.markdown, /described in chapter 3\. It works well\./)
})

test('two columns are read left then right, and the writer is told to check', async () => {
  const left = Array.from({ length: 12 }, (_, i) => `Left column line ${i + 1} with words enough to fill it`)
  const right = Array.from({ length: 12 }, (_, i) => `Right column line ${i + 1} with words enough to fill`)
  const out = await pdfToMarkdown(pdf([{ text: [[72, 740, 18, 'A Paper in Two Columns'], ...lines(50, 700, 10, left, 13), ...lines(320, 700, 10, right, 13)] }]))
  const md = out.markdown
  assert.ok(md.indexOf('Left column line 12') < md.indexOf('Right column line 1 '), md)
  assert.match(md, /line 1 with words enough to fill it Left column line 2/)
  assert.ok(out.notes.some((n) => /Two columns detected; check the reading order/.test(n)))
})

test('a table laid out in columns becomes a table, with a note', async () => {
  const row = (y: number, a: string, b: string, c: string): [number, number, number, string][] => [
    [72, y, 10, a],
    [250, y, 10, b],
    [420, y, 10, c],
  ]
  const out = await pdfToMarkdown(
    pdf([{ text: [...lines(72, 720, 11, ['Results by month.']), ...row(690, 'Month', 'Posts', 'Readers'), ...row(675, 'May', '4', '1200'), ...row(660, 'June', '6', '1800')] }]),
  )
  assert.match(out.markdown, /\| Month \| Posts \| Readers \|\n\| --- \| --- \| --- \|\n\| May \| 4 \| 1200 \|/)
  assert.ok(out.notes.some((n) => /tables may not have come across/i.test(n)))
})

test('scanned pages: some empty pages are flagged, all empty fails with a clear reason', async () => {
  const text: PageSpec = { text: lines(72, 700, 11, ['A page with real text on it.']) }
  const mixed = await pdfToMarkdown(pdf([text, { picture: true }, text, { picture: true }, {}]))
  assert.ok(mixed.notes.includes('Scanned pages with no text — 2 of 5 pages came out empty (pages 2 and 4)'), mixed.notes.join(' | '))
  assert.ok(mixed.notes.includes('Pictures in the PDF were left out'))
  await assert.rejects(pdfToMarkdown(pdf([{ picture: true }, { picture: true }])), (e: Error) => e instanceof ImportError && /pages look scanned.*can’t read scans/.test(e.message))
  await assert.rejects(pdfToMarkdown(pdf([{}, {}])), /blank/)
})

test('password-protected and damaged PDFs fail with a reason the writer can act on', async () => {
  await assert.rejects(pdfToMarkdown(pdf([{ text: [[72, 700, 11, 'Secret']] }], { encrypt: true })), (e: Error) => e instanceof ImportError && /password-protected/.test(e.message))
  await assert.rejects(pdfToMarkdown(Buffer.from('%PDF-1.4\nthis is not really a pdf')), (e: Error) => e instanceof ImportError && /damaged|Couldn’t read/.test(e.message))
})

test('limits: a page cap leaves the rest out with a note; the time limit stops the worker', async () => {
  const pages = Array.from({ length: 5 }, (_, i) => ({ text: lines(72, 700, 11, [`Page ${i + 1} has a sentence of its own.`]) }))
  const capped = await pdfToMarkdown(pdf(pages), { maxPages: 2 })
  assert.match(capped.markdown, /Page 2 has/)
  assert.doesNotMatch(capped.markdown, /Page 3 has/)
  assert.ok(capped.notes.includes('Only the first 2 pages of 5 came across'))
  await assert.rejects(pdfToMarkdown(pdf(pages), { hardMs: 1 }), /took too long/)
})

// ---- Through an import batch, with labels ----------------------------------------------------------

test('a PDF imports as a note: detected by its bytes, metadata and labels in the front matter', async () => {
  const buf = pdf([bookPage(1, lines(72, 700, 11, ['A short essay about drafts.'])), bookPage(2, lines(72, 700, 11, ['And its second page.']))], {
    info: '<< /Title (Drafts) /CreationDate (D:20180607000000Z) >>',
  })
  assert.equal(imp.detectType('drafts.pdf', buf), 'pdf')
  assert.equal(imp.detectType('misnamed.docx', buf), 'pdf')
  const b = await imp.openBatch()
  const item = await imp.addUpload(b.batch, 'drafts.pdf', Date.UTC(2020, 0, 2), [buf])
  assert.equal(item.type, 'pdf')
  assert.equal(item.status, 'converted')
  assert.equal(item.title, 'Drafts')
  assert.equal(item.created, '2018-06-07')
  assert.match(await imp.preview(b.batch, item.id, undefined, ['essays', '#Drafts']), /^tags:\n {2}- essays\n {2}- Drafts$/m)
  const done = await imp.commit(b.batch, item.id, { folder: 'imported', tags: ['essays', '#Drafts', 'essays'] })
  assert.deepEqual(done.tags, ['essays', 'Drafts'])
  const text = await fs.readFile(path.join(root, done.imported!.path), 'utf8')
  assert.match(text, /^title: Drafts$/m)
  assert.match(text, /^created: 2018-06-07$/m)
  assert.match(text, /^source: drafts\.pdf$/m)
  assert.match(text, /^tags:\n {2}- essays\n {2}- Drafts$/m)
  assert.match(text, /A short essay about drafts\.\n\nAnd its second page\.\n$/)

  const scan = await imp.addUpload(b.batch, 'scan.pdf', Date.UTC(2020, 0, 2), [pdf([{ picture: true }])])
  assert.equal(scan.status, 'failed')
  assert.match(scan.reason!, /scanned/)
})
