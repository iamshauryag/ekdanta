// Templates: variable substitution, front-matter merge, and the starter set against a scratch vault.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-templates-'))
process.env.EKDANTA_VAULT = root
const lib = await import('../src/lib/templates.ts')
const server = await import('./templates.ts')
const vault = await import('./vault.ts')
const { DEFAULT_KINDS } = await import('../src/lib/kinds.ts')
const { isPromptParagraph } = await import('../src/lib/special.ts')
const { splitFrontMatter } = await import('../src/lib/frontmatter.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))

const now = new Date(2026, 10, 6, 9, 5) // 6 November 2026, 09:05 (a Friday)
const ctx = (over: Partial<Parameters<typeof lib.renderTemplate>[1]> = {}) => ({ title: 'On Rivers', kind: 'Essay', author: 'Ada Writer', now, ...over })

test('dates and times in Moment notation', () => {
  assert.equal(lib.formatDate(now, 'YYYY-MM-DD'), '2026-11-06')
  assert.equal(lib.formatDate(now, 'MMMM D, YYYY'), 'November 6, 2026')
  assert.equal(lib.formatDate(now, 'D MMMM YYYY'), '6 November 2026')
  assert.equal(lib.formatDate(now, 'dddd, MMM D'), 'Friday, Nov 6')
  assert.equal(lib.formatDate(now, 'HH:mm'), '09:05')
  assert.equal(lib.formatDate(new Date(2026, 0, 1, 15, 7), 'h:mm A'), '3:07 PM')
  assert.equal(lib.formatDate(now, '[Day] D'), 'Day 6')
})

test('every variable is filled in', () => {
  const { text, cursor } = lib.renderTemplate('{{title}} | {{date}} | {{date:MMMM D, YYYY}} | {{ time }} | {{kind}} | {{author}} | {{DATE:YYYY}}', ctx())
  assert.equal(text, 'On Rivers | 2026-11-06 | November 6, 2026 | 09:05 | Essay | Ada Writer | 2026')
  assert.equal(cursor, null)
})

test('{{cursor}} is removed and its place returned; only the first counts', () => {
  const { text, cursor } = lib.renderTemplate('## Intro\n\n{{cursor}}*Prompt: x*\n\n{{cursor}}end', ctx())
  assert.equal(text, '## Intro\n\n*Prompt: x*\n\nend')
  assert.equal(cursor, '## Intro\n\n'.length)
})

test('{{title}} stays for the first title when the piece has none', () => {
  assert.equal(lib.renderTemplate('# {{title}}', ctx({ title: '' })).text, '# {{title}}')
  assert.equal(lib.renderTemplate('# {{title}}', ctx({ title: '  ' })).text, '# {{title}}')
})

test('a missing name on a line of its own becomes a prompt; inline it is just blank', () => {
  assert.equal(lib.renderTemplate('{{author}}\n\nBy {{author}}.', ctx({ author: '' })).text, '*Prompt: Your name*\n\nBy .')
})

test("Templater's <% %>, unknown variables and [[links]] are left as written", () => {
  const src = '<% tp.date.now("{{date}}") %> {{date}} {{weather}} [[on-rivers]] [[a|b]]'
  assert.equal(lib.renderTemplate(src, ctx()).text, '<% tp.date.now("{{date}}") %> 2026-11-06 {{weather}} [[on-rivers]] [[a|b]]')
})

test('front matter merges: the piece keeps title, created and kind; other template keys are added', () => {
  const doc = '---\ntitle: On Rivers\nplatform: essay\nstatus: draft\ncreated: 2026-11-01\n---\n\n'
  const tpl =
    '---\ntemplate-for: linkedin\ntemplate-name: Post\ntitle: Template title\ncreated: 2020-01-01\nplatform: linkedin\nstatus: idea\naudience: students\ndue: {{date}}\n---\n\n\n{{cursor}}# {{title}}\n\nBody'
  const { content, cursor } = lib.applyTemplate(doc, tpl, ctx())
  const { meta, body } = splitFrontMatter(content)
  assert.deepEqual(meta, { title: 'On Rivers', platform: 'essay', status: 'idea', created: '2026-11-01', audience: 'students', due: '2026-11-06' })
  assert.equal(body, '# On Rivers\n\nBody')
  assert.equal(cursor, 0)
})

test('a template without front matter fills the body only', () => {
  const doc = '---\ntitle: \nplatform: essay\n---\n\n'
  const { content } = lib.applyTemplate(doc, 'Hello {{kind}}', ctx())
  assert.equal(splitFrontMatter(content).body, 'Hello Essay')
  assert.equal(splitFrontMatter(content).meta.platform, 'essay')
})

test('templateInfo reads the name and kind', () => {
  assert.deepEqual(lib.templateInfo('templates/x.md', '---\ntemplate-name: LinkedIn post\ntemplate-for: LinkedIn\n---\n'), { path: 'templates/x.md', name: 'LinkedIn post', kind: 'linkedin' })
  assert.deepEqual(lib.templateInfo('templates/daily-note.md', 'just text'), { path: 'templates/daily-note.md', name: 'Daily note', kind: '' })
  assert.equal(lib.templateInfo('templates/a.md', '---\ntitle: Weekly\nplatform: blog\n---\n').kind, 'blog')
})

test('groups follow the kinds; a deleted kind is listed under Other', () => {
  const t = (name: string, kind: string) => ({ path: `templates/${name}.md`, name, kind })
  const groups = lib.groupTemplates([t('a', 'linkedin'), t('b', 'essay'), t('c', ''), t('d', 'podcast')], DEFAULT_KINDS)
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((i) => i.name)]),
    [
      ['Essay', ['b']],
      ['LinkedIn post', ['a']],
      ['Any kind', ['c']],
      ['Other', ['d']],
    ],
  )
})

test('fuzzy matching', () => {
  assert.ok(lib.fuzzyScore('lnk', 'LinkedIn post') > 0)
  assert.equal(lib.fuzzyScore('xyz', 'LinkedIn post'), 0)
  assert.ok(lib.fuzzyScore('yt', 'YouTube script') > 0)
  assert.ok(lib.fuzzyScore('acad', 'Academic essay') > lib.fuzzyScore('acad', 'Lab report: a cad'))
  assert.equal(lib.fuzzyScore('', 'anything'), 1)
})

test('every starter gives structure and prompts, and its prompts are prompt paragraphs', () => {
  for (const s of server.STARTERS) {
    const { meta, body } = splitFrontMatter(s.content)
    assert.equal(meta['template-name'], s.name)
    const prompts = lib
      .renderTemplate(body, ctx())
      .text.split(/\n\s*\n/)
      .filter((p) => /Prompt:/.test(p))
    assert.ok(prompts.length > 0, s.name)
    for (const p of prompts) assert.ok(isPromptParagraph(p), `${s.name}: ${p}`)
  }
  const names = server.STARTERS.map((s) => s.name)
  for (const n of ['Academic essay', 'Research paper', 'Lab report', 'LinkedIn post', 'YouTube script', 'Newsletter', 'Cover letter', 'Meeting notes', 'Book notes']) assert.ok(names.includes(n), n)
  // The LinkedIn post is nothing but prompts, so a new post from it counts no words.
  const li = splitFrontMatter(server.STARTERS.find((s) => s.name === 'LinkedIn post')!.content).body
  assert.ok(
    lib
      .renderTemplate(li, ctx())
      .text.split(/\n\s*\n/)
      .every((p) => !p.trim() || isPromptParagraph(p)),
  )
})

test('seeding adds only the missing starters and never replaces a file', async () => {
  await vault.writeDoc('templates/linkedin-post.md', 'mine')
  const { added } = await server.seedTemplates()
  assert.equal(added.length, server.STARTERS.length - 1)
  assert.ok(!added.includes('templates/linkedin-post.md'))
  assert.equal(await fs.readFile(path.join(root, 'templates/linkedin-post.md'), 'utf8'), 'mine')
  assert.deepEqual((await server.seedTemplates()).added, [])
  const list = await server.listTemplates()
  assert.equal(list.length, server.STARTERS.length)
  assert.deepEqual(
    list.find((t) => t.path === 'templates/academic-essay.md'),
    { path: 'templates/academic-essay.md', name: 'Academic essay', kind: 'essay' },
  )
})

test('applying fills an empty piece; a vanished template or a piece with writing is refused', async () => {
  await vault.writeDoc('essays/untitled.md', '---\ntitle: \nplatform: essay\nstatus: draft\ncreated: 2026-11-06\n---\n\n')
  const { cursor } = await server.applyTemplateTo('essays/untitled.md', 'templates/academic-essay.md')
  const { meta, body } = splitFrontMatter(await vault.readDoc('essays/untitled.md'))
  assert.equal(meta.platform, 'essay')
  assert.equal(meta['template-for'], undefined)
  assert.match(body, /^\*Prompt: Your name\*/)
  assert.match(body, new RegExp(lib.formatDate(new Date(), 'D MMMM YYYY')))
  assert.match(body, /# \{\{title\}\}/)
  assert.ok(cursor !== null && body.slice(cursor).startsWith('*Prompt: What question'))
  await assert.rejects(server.applyTemplateTo('essays/untitled.md', 'templates/academic-essay.md'), /already has writing/)
  await vault.writeDoc('essays/untitled-2.md', '---\ntitle: \n---\n\n')
  await assert.rejects(server.applyTemplateTo('essays/untitled-2.md', 'templates/gone.md'), /Template not found/)
  await assert.rejects(server.applyTemplateTo('essays/untitled-2.md', 'essays/untitled.md'), /Not a template/)
  assert.equal(splitFrontMatter(await vault.readDoc('essays/untitled-2.md')).body, '')
})

test('a template passes on its other front matter, and keeps its own keys to itself', () => {
  const template = '---\ntemplate-name: Lab report\ntemplate-for: essay\nstatus: draft\nfor: {{kind}}, {{date:YYYY}}\n---\n\nBody\n'
  assert.deepEqual(lib.templateMeta(template, ctx()), { status: 'draft', for: 'Essay, 2026' })
})

test('every starter is for a kind the writer already has', () => {
  for (const s of server.STARTERS) {
    const kind = lib.templateInfo(`templates/${s.file}`, s.content).kind
    if (!kind) continue
    assert.ok(
      DEFAULT_KINDS.some((k) => k.id === kind),
      `${s.name} is for "${kind}", which is not a kind by default, so it would be listed under Other`,
    )
  }
})
