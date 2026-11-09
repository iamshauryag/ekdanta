// Ideas: parsing the writer's ideas.md leniently, appending to it, and starting a piece from an idea.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-ideas-'))
process.env.EKDANTA_VAULT = root
const ideas = await import('./ideas.ts')
const vault = await import('./vault.ts')
const { DEFAULT_KINDS } = await import('../src/lib/kinds.ts')
const { saveSettings } = await import('./settings.ts')
const { isPromptParagraph, isSpecialPath, isSpecialFile } = await import('../src/lib/special.ts')
const { splitFrontMatter } = await import('../src/lib/frontmatter.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))

test('dates are short, plain and the same in every locale', () => {
  assert.equal(ideas.formatIdeaDate(new Date(2026, 10, 6)), '6 Nov 2026')
  assert.equal(ideas.formatIdeaDate(new Date(2027, 0, 31)), '31 Jan 2027')
})

test('an idea is one tidy line with no list marker of its own', () => {
  assert.equal(ideas.cleanIdea('  a  thought\nacross\tlines '), 'a thought across lines')
  assert.equal(ideas.cleanIdea('- already a bullet'), 'already a bullet')
  assert.equal(ideas.cleanIdea('* - [ ] nested'), 'nested')
  // A number is the writer's own words ("3. reasons…"), not a marker to strip.
  assert.equal(ideas.cleanIdea('3. reasons I quit coffee'), '3. reasons I quit coffee')
  assert.equal(ideas.cleanIdea('- 10) things'), '10) things')
  assert.equal(ideas.cleanIdea('-dash-led'), '-dash-led')
  assert.equal(ideas.cleanIdea('   '), '')
  assert.equal(ideas.ideaLine('walk to think', '6 Nov 2026'), '- walk to think (6 Nov 2026)')
})

test('ideas.md is read leniently: any list item or plain line', () => {
  const raw = [
    '---',
    'title: Ideas',
    '---',
    '# Ideas',
    '',
    '- first idea (5 Nov 2026)',
    '* phone bullet',
    '+ plus bullet',
    '1. numbered one',
    '- [ ] a task box',
    '- [x] a done box (2026-11-01)',
    'no bullet at all',
    '> quoted thought',
    '- a long idea that',
    '  wraps onto a second line (6 Nov 2026)',
    '',
    '---',
    '* * *',
    '## Later',
    '<!-- a note to self',
    'still a comment -->',
    '```',
    'code is not an idea',
    '```',
    '- ',
    '- (6 Nov 2026)',
    '#hashtag idea',
  ].join('\n')
  assert.deepEqual(ideas.parseIdeas(raw), [
    { text: 'first idea', date: '5 Nov 2026' },
    { text: 'phone bullet' },
    { text: 'plus bullet' },
    { text: 'numbered one' },
    { text: 'a task box' },
    { text: 'a done box', date: '2026-11-01' },
    { text: 'no bullet at all' },
    { text: 'quoted thought' },
    { text: 'a long idea that wraps onto a second line', date: '6 Nov 2026' },
    // A bare date is kept as the idea rather than dropped.
    { text: '(6 Nov 2026)' },
    { text: '#hashtag idea' },
  ])
  assert.deepEqual(ideas.parseIdeas(''), [])
  assert.deepEqual(ideas.parseIdeas('a\r\nb\r\n'), [{ text: 'a' }, { text: 'b' }])
})

test('an idea ending in its own bracketed date keeps it; only the last date is the capture date', () => {
  const line = ideas.ideaLine('launch (12 Dec 2026)', '6 Nov 2026')
  assert.deepEqual(ideas.parseIdeas(line), [{ text: 'launch (12 Dec 2026)', date: '6 Nov 2026' }])
})

test('newest first, one row per idea at its newest', () => {
  const list = ideas.parseIdeas('- a (1 Nov 2026)\n- b (2 Nov 2026)\n- a (3 Nov 2026)\nc')
  assert.deepEqual(ideas.newestFirst(list), [{ text: 'c' }, { text: 'a', date: '3 Nov 2026' }, { text: 'b', date: '2 Nov 2026' }])
})

test('appending: a missing file starts with a heading, the same idea twice a day is not added again', () => {
  const first = ideas.appendIdea(null, 'one', '6 Nov 2026')
  assert.deepEqual(first, { content: '# Ideas\n\n- one (6 Nov 2026)\n', added: true })
  const again = ideas.appendIdea(first.content, '  one ', '6 Nov 2026')
  assert.equal(again.added, false)
  assert.equal(again.content, first.content)
  const tomorrow = ideas.appendIdea(first.content, 'one', '7 Nov 2026')
  assert.equal(tomorrow.added, true)
  // A file without a final newline (or with several) gets exactly one before the new line.
  assert.equal(ideas.appendIdea('- x', 'y', '6 Nov 2026').content, '- x\n- y (6 Nov 2026)\n')
  assert.equal(ideas.appendIdea('- x\n\n\n', 'y', '6 Nov 2026').content, '- x\n- y (6 Nov 2026)\n')
  assert.equal(ideas.appendIdea('   \n', 'y', '6 Nov 2026').content, '# Ideas\n\n- y (6 Nov 2026)\n')
  assert.throws(() => ideas.appendIdea('', '  \n ', '6 Nov 2026'), /needs some words/)
})

test('long pasted text is kept whole', () => {
  const long = 'word '.repeat(400).trim()
  const { content } = ideas.appendIdea(null, long, '6 Nov 2026')
  assert.equal(ideas.parseIdeas(content)[0].text, long)
})

test('the prompt is a template prompt whatever the idea holds', () => {
  for (const idea of ['plain idea', 'stars * and _under_ and `code`', 'ends with a backslash \\', 'a [[link]] and <b>html</b> ==mark==', 'a | pipe and # hash'])
    assert.equal(isPromptParagraph(ideas.ideaPrompt(idea)), true, idea)
  assert.equal(ideas.ideaPrompt('a *b*'), '*Prompt: a \\*b\\**')
})

test('a template body loses its front matter and {{cursor}}; date and kind are filled', () => {
  assert.equal(
    ideas.templateBody('---\ntemplate-for: blog\n---\n\n## Hook\n{{cursor}}*Prompt: open strong*\n{{date}} · {{kind}}', { date: '2026-11-06', kind: 'Blog post' }),
    '## Hook\n*Prompt: open strong*\n2026-11-06 · Blog post',
  )
})

test('ideas.md is a special file: left out of Recall, voice and filing', () => {
  assert.equal(isSpecialFile('ideas.md'), true)
  assert.equal(isSpecialFile('Ideas.md'), true)
  assert.equal(isSpecialFile('notes/ideas.md'), false)
  assert.equal(isSpecialPath('ideas.md'), true)
  assert.equal(isSpecialPath('/ideas.md'), true)
  assert.equal(isSpecialPath('essays/ideas.md'), false)
  assert.equal(isSpecialPath('ideas.md.bak'), false)
})

test('capture appends to ideas.md, keeps outside edits, and skips a same-day repeat', async () => {
  const day = '6 Nov 2026'
  assert.deepEqual(await ideas.captureIdea('first', day), { added: true, text: 'first', date: day })
  // An edit made elsewhere (a phone, say) in between is kept.
  await fs.appendFile(path.join(root, 'ideas.md'), '* typed on a phone\n')
  await ideas.captureIdea('second', day)
  assert.deepEqual((await ideas.captureIdea('second', day)).added, false)
  // Two at once both land.
  await Promise.all([ideas.captureIdea('third', day), ideas.captureIdea('fourth', day)])
  const raw = await fs.readFile(path.join(root, 'ideas.md'), 'utf8')
  assert.equal(raw, `# Ideas\n\n- first (${day})\n* typed on a phone\n- second (${day})\n- third (${day})\n- fourth (${day})\n`)
  const { exists, ideas: rows } = await ideas.listIdeas()
  assert.equal(exists, true)
  assert.deepEqual(
    rows.map((r) => r.text),
    ['fourth', 'third', 'second', 'typed on a phone', 'first'],
  )
})

test('stars live in app state and never change ideas.md', async () => {
  const before = await fs.readFile(path.join(root, 'ideas.md'), 'utf8')
  await ideas.starIdea('second', true)
  await ideas.starIdea('first', true)
  await ideas.starIdea('first', false)
  const rows = (await ideas.listIdeas()).ideas
  assert.deepEqual(
    rows.filter((r) => r.starred).map((r) => r.text),
    ['second'],
  )
  assert.equal(await fs.readFile(path.join(root, 'ideas.md'), 'utf8'), before)
  await assert.rejects(ideas.starIdea('  ', true), /No idea/)
})

test('starting a piece files it by kind with the idea as a prompt; deleting it un-starts the idea', async () => {
  const before = await fs.readFile(path.join(root, 'ideas.md'), 'utf8')
  const rel = await ideas.startIdea('third', 'blog')
  assert.match(rel, /^blog\/untitled(-\d+)?\.md$/)
  const { meta, body } = splitFrontMatter(await fs.readFile(path.join(root, rel), 'utf8'))
  assert.equal(meta['from-idea'], 'third')
  assert.equal(meta.platform, 'blog')
  assert.equal(body.trim(), '*Prompt: third*')
  let row = (await ideas.listIdeas()).ideas.find((r) => r.text === 'third')
  assert.equal(row?.started?.path, rel)
  // ideas.md is untouched by starting.
  assert.equal(await fs.readFile(path.join(root, 'ideas.md'), 'utf8'), before)
  await vault.trashDoc(rel)
  row = (await ideas.listIdeas()).ideas.find((r) => r.text === 'third')
  assert.equal(row?.started, undefined)
  await assert.rejects(ideas.startIdea('x', 'no-such-kind'), /Unknown kind/)
  await assert.rejects(ideas.startIdea(' ', 'blog'), /No idea/)
  // No kind: Unfiled, at the top of the vault, with no kind in its front matter.
  const loose = await ideas.startIdea('fourth', '')
  assert.match(loose, /^untitled(-\d+)?\.md$/)
  assert.equal(splitFrontMatter(await fs.readFile(path.join(root, loose), 'utf8')).meta.platform, undefined)
})

test("a kind's template goes under the prompt", async () => {
  await fs.mkdir(path.join(root, 'templates'), { recursive: true })
  await fs.writeFile(path.join(root, 'templates/blog.md'), '---\ntemplate-for: blog\n---\n\n## Hook\n\n*Prompt: open strong*\n')
  await saveSettings({ kinds: DEFAULT_KINDS.map((k) => (k.id === 'blog' ? { ...k, template: 'templates/blog.md' } : k)) })
  const rel = await ideas.startIdea('with a template', 'blog')
  const { body } = splitFrontMatter(await fs.readFile(path.join(root, rel), 'utf8'))
  assert.equal(body, '*Prompt: with a template*\n\n## Hook\n\n*Prompt: open strong*\n')
  // A template that has gone missing just leaves the prompt.
  await saveSettings({ kinds: DEFAULT_KINDS.map((k) => (k.id === 'blog' ? { ...k, template: 'templates/missing.md' } : k)) })
  const rel2 = await ideas.startIdea('no template', 'blog')
  assert.equal(splitFrontMatter(await fs.readFile(path.join(root, rel2), 'utf8')).body, '*Prompt: no template*\n')
})

test('an idea ending in a quote mark, or starting with #, still shows Started', async () => {
  for (const idea of ['Why I said "no"', "notes on my parents'", '# big headline idea', '3. reasons I quit coffee']) {
    await ideas.captureIdea(idea)
    const rel = await ideas.startIdea(idea, 'blog')
    const raw = await fs.readFile(path.join(root, rel), 'utf8')
    assert.equal(splitFrontMatter(raw).meta['from-idea'], idea)
    // Quoted in the file, so other YAML readers (Obsidian) see the same value.
    if (!idea.startsWith('3')) assert.ok(raw.includes(`from-idea: ${JSON.stringify(idea)}`), raw)
    const row = (await ideas.listIdeas()).ideas.find((r) => r.text === idea)
    assert.equal(row?.started?.path, rel, idea)
  }
})

test('the vault listing carries from-idea', async () => {
  const f = (await vault.listFiles()).find((x) => x.fromIdea === 'with a template')
  assert.ok(f)
})
