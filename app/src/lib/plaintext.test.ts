import test from 'node:test'
import assert from 'node:assert/strict'
import { charCount, defaultFormat, exportName, htmlDocument, prepare, syntaxWarnings, toHtml, toMarkdown, toText, unicodeBold } from './plaintext.ts'

const pages: Record<string, { title: string; path: string }> = {
  'on-being-edited': { title: 'On Being Edited', path: 'essays/on-being-edited.md' },
}
const page = (t: string) => pages[t] ?? null

test('front matter goes; title, author and date are kept apart', () => {
  const p = prepare('---\ntitle: On Walking\nauthor: Ada Lovelace\ndate: 2026-11-06\nplatform: essay\nstatus: draft\nexemplar: true\n---\n\nFirst paragraph.\n', { page })
  assert.equal(p.title, 'On Walking')
  assert.equal(p.author, 'Ada Lovelace')
  assert.equal(p.date, '2026-11-06')
  assert.equal(p.body, 'First paragraph.\n')
  assert.deepEqual(p.warnings, [])
})

test('[[links]] become their labels, unresolved ones plain text', () => {
  const p = prepare('See [[on-being-edited|my essay]], [[on-being-edited]] and [[nowhere]].\n', { page })
  assert.equal(p.body, 'See my essay, On Being Edited and nowhere.\n')
  const md = prepare('See [[on-being-edited|my essay]] and [[nowhere]].\n', { page, link: (pg) => '../' + pg.path })
  assert.equal(md.body, 'See [my essay](../essays/on-being-edited.md) and nowhere.\n')
})

test('links inside code are left alone', () => {
  const p = prepare('Use `[[x]]` here.\n\n```\n[[on-being-edited]] <div>\n```\n', { page })
  assert.equal(p.body, 'Use `[[x]]` here.\n\n```\n[[on-being-edited]] <div>\n```\n')
  assert.deepEqual(p.warnings, [])
})

test('template prompts are dropped', () => {
  const p = prepare('*Prompt: what happened first?*\n\nMy own words.\n\n**Prompt:** and then?\n', { page })
  assert.equal(p.body, 'My own words.\n')
})

test('raw HTML is exported as text, with a warning; comments and <u> are not', () => {
  const p = prepare('<div class="x">\nhello\n</div>\n\nSome <u>under</u> and <span>span</span>.\n\n<!-- a note -->\n\nEnd<!-- inline -->.\n', { page })
  assert.match(p.body, /^\\<div class="x">\nhello\n\\<\/div>\n/)
  assert.match(p.body, /Some <u>under<\/u> and \\<span>span\\<\/span>\./)
  assert.doesNotMatch(p.body, /a note|inline/)
  assert.deepEqual(p.warnings, ['1 HTML block exported as text', '2 HTML tags exported as text'])
  // And it reads back as the text it was.
  assert.match(toHtml(p.body), /&lt;div class=&quot;x&quot;&gt;/)
})

test('images resolve through the callback; missing ones are listed and dropped', () => {
  const p = prepare('![a cat](../attachments/cat.png)\n\n![gone](gone.png "t")\n\n![[cat.png]]\n', {
    page,
    image: (src) => (src.includes('gone') ? { warning: `Image missing: ${src}` } : { src: '/vault/attachments/' + src.split('/').pop() }),
  })
  assert.equal(p.body, '![a cat](/vault/attachments/cat.png)\n\n![](/vault/attachments/cat.png)\n')
  assert.deepEqual(p.warnings, ['Image missing: gone.png'])
  const spaced = prepare('![x](a.png)\n', { page, image: () => ({ src: '/my vault/a.png' }) })
  assert.equal(spaced.body, '![x](</my vault/a.png>)\n')
})

test('footnotes and citations are counted; only engines without them warn', () => {
  const p = prepare('A claim.[^1] Another [@smith2020, p. 4].\n\n[^1]: The note.\n', { page })
  assert.deepEqual(p.counts, { footnotes: 1, citations: 1 })
  assert.equal(syntaxWarnings(p.counts, 'built-in').length, 2)
  assert.equal(syntaxWarnings(p.counts, 'pandoc').length, 1)
  assert.deepEqual(syntaxWarnings(p.counts, 'markdown'), [])
  assert.deepEqual(syntaxWarnings(prepare('mail me at a@b.com\n', { page }).counts, 'built-in'), [])
})

test('clean Markdown keeps only title and date', () => {
  const p = prepare('---\ntitle: "Notes: one"\nplatform: essay\ndate: 2026-01-02\n---\n\nBody.\n', { page })
  assert.equal(toMarkdown(p), '---\ntitle: "Notes: one"\ndate: 2026-01-02\n---\n\nBody.\n')
  assert.equal(toMarkdown(prepare('Body.\n', { page })), 'Body.\n')
})

test('LinkedIn text: blank lines, • bullets, headings alone, links with their URL', () => {
  const body = prepare(
    '# Three things\n\nI learned **three** things\nthis week:\n\n- listen\n- ask [why](https://example.com/why)\n  - twice\n- see <https://example.com>\n\n1. one\n2. two\n\n> A quote.\n\n![pic](x.png)\n',
    { page },
  ).body
  const { text, warnings } = toText(body, { style: 'linkedin' })
  assert.equal(text, 'Three things\n\nI learned three things\nthis week:\n\n• listen\n• ask why (https://example.com/why)\n   • twice\n• see https://example.com\n\n1. one\n2. two\n\n“A quote.”')
  assert.deepEqual(warnings, ["1 image left out: text can't carry pictures"])
  const bold = toText(body, { style: 'linkedin', bold: true }).text
  assert.ok(bold.startsWith(unicodeBold('Three things') + '\n\nI learned ' + unicodeBold('three') + ' things'))
})

test('plain text uses - bullets and > quotes, tables as lines', () => {
  const { text, warnings } = toText('- a\n- [b](/rel.md)\n\n> q\n\n| x | y |\n| - | - |\n| 1 | 2 |\n', { style: 'plain' })
  assert.equal(text, '- a\n- b\n\n> q\n\nx | y\n1 | 2')
  assert.deepEqual(warnings, ['1 table flattened into lines'])
})

test('Unicode bold maps Latin letters and digits only', () => {
  assert.equal(unicodeBold('Ab9 é!'), '𝗔𝗯𝟵 é!')
  assert.equal(charCount(unicodeBold('Ab9')), 3)
  assert.equal(charCount('👋 hi'), 4)
})

test('HTML: highlights, underline, tasks and a standalone page', () => {
  assert.match(toHtml('==hi== <u>u</u> ~~s~~\n'), /<mark>hi<\/mark> <u>u<\/u> <s>s<\/s>/)
  assert.match(toHtml('- [ ] todo\n- [x] done\n'), /<li class="task">☐ todo<\/li>\n<li class="task">☑ done/)
  assert.match(toHtml('a\nb\n'), /a<br \/>\nb/)
  const doc = htmlDocument(prepare('---\ntitle: A <b> title\nauthor: Me\n---\n\nText.\n', { page }))
  assert.match(doc, /<title>A &lt;b&gt; title<\/title>/)
  assert.match(doc, /<style>/)
  assert.match(doc, /<p class="byline">Me<\/p>/)
})

test('file names: Unicode kept, slashes and colons gone', () => {
  assert.equal(exportName('Café / Notes: Part 2', 'docx'), 'cafe-notes-part-2.docx')
  assert.equal(exportName('लेखन की कला', 'pdf'), 'लेखन-की-कला.pdf')
  assert.equal(exportName('a/b\\c', 'md'), 'a-b-c.md')
  assert.equal(exportName('🙂', 'html', 'untitled-3'), 'untitled-3.html')
  assert.equal(exportName('', 'docx', ''), 'export.docx')
  assert.ok(Array.from(exportName('x'.repeat(200), '')).length <= 80)
})

test('LinkedIn kinds default to Copy for LinkedIn', () => {
  assert.equal(defaultFormat({ id: 'linkedin', name: 'LinkedIn post' }), 'linkedin')
  assert.equal(defaultFormat({ id: 'li', name: 'Linkedin carousel' }), 'linkedin')
  assert.equal(defaultFormat({ id: 'essay', name: 'Essay' }), 'docx')
  assert.equal(defaultFormat(null), 'docx')
})
