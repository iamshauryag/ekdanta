import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { builtinDocx, imageSize } from './export-docx.ts'
import { forPandoc } from './export.ts'

test('underline and highlight become spans pandoc reads, outside code only', () => {
  assert.equal(forPandoc('a <u>b c</u> and ==d e== `==x== <u>y</u>`\n'), 'a [b c]{.underline} and [d e]{.mark} `==x== <u>y</u>`\n')
  assert.equal(forPandoc('```\n<u>z</u> ==q==\n```\n==r==\n'), '```\n<u>z</u> ==q==\n```\n[r]{.mark}\n')
  assert.equal(forPandoc('    <u>indented code</u>\n'), '    <u>indented code</u>\n')
  // A stray tag can't leave raw HTML behind; == with spaces inside isn't a highlight.
  assert.equal(forPandoc('<u>open only and a == b ==\n'), 'open only and a == b ==\n')
})

test('image sizes from PNG, GIF and JPEG headers', () => {
  const png = Buffer.alloc(33)
  png.writeUInt32BE(0x89504e47, 0)
  png.writeUInt32BE(320, 16)
  png.writeUInt32BE(120, 20)
  assert.deepEqual(imageSize(png), { type: 'png', width: 320, height: 120 })
  const gif = Buffer.from('GIF89a\x10\x00\x08\x00\x00\x00\x00', 'latin1')
  assert.deepEqual(imageSize(gif), { type: 'gif', width: 16, height: 8 })
  // SOI, an APP0 segment, then a baseline frame of 40×30.
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x00, 0x28, 0x03, 0, 0, 0, 0])
  assert.deepEqual(imageSize(jpg), { type: 'jpg', width: 40, height: 30 })
  assert.equal(imageSize(Buffer.from('<svg/>')), null)
})

/** The paragraphs of a .docx: their text, and whether each carries a list mark. */
async function paragraphs(data: Buffer) {
  const xml = await (await JSZip.loadAsync(data)).file('word/document.xml')!.async('string')
  return [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>|<w:p [^>]*>([\s\S]*?)<\/w:p>/g)].map((m) => {
    const p = m[1] ?? m[2]
    return { text: [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''), listed: /<w:numPr>/.test(p), heading: /w:val="Heading/.test(p) }
  })
}

test('a list item that starts with a heading or code keeps every word once, with its mark', async () => {
  const body = '- ## Item heading\n\n  after the heading\n\n- ```\n  code first\n  ```\n\n  after the code\n\n- plain item\n- \n'
  const { data } = await builtinDocx({ title: '', author: '', date: '', body, warnings: [], counts: { footnotes: 0, citations: 0 } })
  const ps = (await paragraphs(data)).filter((p) => p.text || p.listed)
  const texts = ps.map((p) => p.text)
  for (const t of ['Item heading', 'after the heading', 'code first', 'after the code', 'plain item']) assert.equal(texts.filter((x) => x === t).length, 1, t)
  const by = (t: string) => ps.find((p) => p.text === t)!
  assert.ok(by('Item heading').listed && by('Item heading').heading)
  assert.ok(by('code first').listed)
  assert.ok(!by('after the heading').listed && !by('after the code').listed)
  assert.ok(by('plain item').listed)
  // The empty last item still shows its bullet.
  assert.equal(ps.filter((p) => p.listed).length, 4)
})
