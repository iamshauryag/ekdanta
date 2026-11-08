// Break it down on the server: the help ceiling held in code, passages checked against the piece,
// new posts linked back, and the piece itself never touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-breakdown-'))
process.env.EKDANTA_VAULT = root
process.env.EKDANTA_DISABLE_CLAUDE_CLI = '1'
const { allowance, breakdownOptions, planBreakdown, createPosts, checkPlan, cleanAngle, Cancelled } = await import('./breakdown.ts')
const settingsMod = await import('./settings.ts')
const vault = await import('./vault.ts')
const { splitFrontMatter } = await import('../src/lib/frontmatter.ts')
const { derivedFrom, threadParts, unitsOf } = await import('../src/lib/breakdown.ts')
const { DEFAULT_KINDS } = await import('../src/lib/kinds.ts')
const { xLength } = await import('../src/lib/targets.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))

const DOC = 'essays/why-slow-writing-matters.md'
const BODY = `I used to think slow writing was a kind of vanity, a way of dressing up hesitation as craft. Then I spent a winter drafting one essay a week, and the weeks that produced the worst pages were always the ones I rushed.[^1]

Speed gives you the first idea that arrives, and the first idea is rarely yours. It is the common one, worn smooth by everyone who reached for it before you. Slowness is how you get past it, to the second and third, where the strange and particular things live.

![my desk](desk.jpg)

There is a physical part to it as well. When I write by hand the sentence has to survive the whole length of my arm before it reaches the page, and most of the lazy ones do not make the journey.

What I have stopped doing is apologising for the pace. A slow paragraph is not a failed fast one; it is a different kind of object, one that has been looked at from more than one side.

[^1]: Mostly in January.
`
const SOURCE = `---\ntitle: Why Slow Writing Matters\nplatform: essay\nstatus: draft\n---\n\n${BODY}`

await fs.mkdir(path.join(root, 'essays'), { recursive: true })
await fs.mkdir(path.join(root, 'linkedin'), { recursive: true })
await fs.writeFile(path.join(root, DOC), SOURCE)
await fs.writeFile(
  path.join(root, 'linkedin/hiring-is-listening.md'),
  `---\ntitle: Hiring is listening\nplatform: linkedin\n---\n\nThe best interview I ever ran was mostly silence.\n\nI asked one question and waited.\n`,
)

const sourceState = async () => ({ bytes: await fs.readFile(path.join(root, DOC), 'utf8'), mtime: (await fs.stat(path.join(root, DOC))).mtimeMs })
const never = async () => {
  throw new Error('the model must not be asked')
}
const fake = (reply: unknown) => {
  const calls: { system: string; prompt: string }[] = []
  return { calls, ask: async (system: string, prompt: string) => (calls.push({ system, prompt }), typeof reply === 'string' ? reply : JSON.stringify(reply)) }
}
const quiet = { voice: async () => '' }

const PLAN = {
  posts: [
    {
      target: 1,
      angle: 'Lead with the winter of one essay a week',
      opening: 'I rushed my worst pages.',
      passages: [
        { p: 1, text: 'Then I spent a winter drafting one essay a week, and the weeks that produced the worst pages were always the ones I rushed.' },
        { p: 2, text: 'A sentence the model made up about productivity.' },
      ],
    },
    { target: 2, angle: 'The first idea is rarely yours', passages: [{ p: 2, text: 'Speed gives you the first idea that arrives, and the first idea is rarely yours.' }] },
    { target: 2, angle: 'One too many', passages: [{ p: 3, text: 'There is a physical part to it as well.' }] },
  ],
}
const TARGETS = [
  { format: 'linkedin', count: 1 },
  { format: 'x-post', count: 1 },
]

test('what each help level allows', () => {
  assert.deepEqual(allowance(0), { level: 0, plan: 'off', opening: false, adapt: 'none' })
  assert.deepEqual(allowance(1), { level: 1, plan: 'sections', opening: false, adapt: 'none' })
  assert.deepEqual(allowance(3), { level: 3, plan: 'model', opening: false, adapt: 'none' })
  assert.deepEqual(allowance(4), { level: 4, plan: 'model', opening: true, adapt: 'none' })
  assert.deepEqual(allowance(5), { level: 5, plan: 'model', opening: true, adapt: 'passages' })
  // A higher "whole drafts" level, when settings have one, only widens the adaptation.
  assert.deepEqual(allowance(6), { level: 6, plan: 'model', opening: true, adapt: 'whole' })
})

test('options name the formats, where they file, and the writer’s own habits', async () => {
  const o = await breakdownOptions(DOC, { ceiling: 3, ...quiet })
  assert.equal(o.title, 'Why Slow Writing Matters')
  assert.equal(o.short, null)
  const li = o.formats.find((f) => f.id === 'linkedin')!
  assert.equal(li.adds, false)
  assert.equal(li.folder, 'linkedin')
  assert.equal(li.habit.pieces, 1)
  assert.equal(li.habit.voice, false)
  const x = o.formats.find((f) => f.id === 'x-post')!
  assert.equal(x.adds, true)
  assert.equal(x.kind, 'X post')
  assert.equal(x.folder, 'x-posts')
})

test('help ceiling 0: off, on the server', async () => {
  const r = await planBreakdown({ doc: DOC, targets: TARGETS }, { ceiling: 0, ask: never, ...quiet })
  assert.equal(r.kind, 'off')
  await assert.rejects(createPosts({ doc: DOC, posts: [{ format: 'linkedin', passages: [] }] }, { ceiling: 0, ask: never }), /off/)
})

test('help ceiling 1: the plan comes from the piece’s sections, with no model', async () => {
  const r = await planBreakdown({ doc: DOC, targets: TARGETS }, { ceiling: 1, ask: never, ...quiet })
  assert.equal(r.kind, 'plan')
  if (r.kind !== 'plan') return
  assert.equal(r.by, 'sections')
  assert.equal(r.posts.length, 2)
  assert.ok(r.posts.every((p) => !p.hook))
})

test('help ceiling 3: the model picks passages; invented ones, openings and extra posts are dropped', async () => {
  const m = fake(PLAN)
  const r = await planBreakdown({ doc: DOC, targets: TARGETS }, { ceiling: 3, ask: m.ask, ...quiet })
  assert.equal(r.kind, 'plan')
  if (r.kind !== 'plan') return
  assert.equal(r.by, 'model')
  assert.equal(r.posts.length, 2)
  assert.equal(r.posts[0].passages.length, 1)
  assert.ok(r.posts.every((p) => p.hook === undefined))
  assert.match(r.notes.join(' '), /1 passage the model gave/)
  // The writer's habits go into the ask, not generic platform advice; the opening isn't asked for.
  assert.match(m.calls[0].prompt, /writer's own LinkedIn posts run about/)
  assert.doesNotMatch(m.calls[0].system, /"opening"/)
})

test('help ceiling 4: one suggested opening line per post, checked to be one sentence that fits', async () => {
  const r = await planBreakdown({ doc: DOC, targets: TARGETS }, { ceiling: 4, ask: fake(PLAN).ask, ...quiet })
  if (r.kind !== 'plan') return assert.fail(r.kind)
  assert.equal(r.posts[0].hook, 'I rushed my worst pages.')
  const tooLong = checkPlan(JSON.stringify({ posts: [{ ...PLAN.posts[0], opening: 'One sentence. And then another one.' }] }), unitsOf(BODY), TARGETS, DEFAULT_KINDS, allowance(4))
  assert.equal(tooLong.posts[0].hook, undefined)
})

test('no model: the plan follows the sections and says why', async () => {
  const r = await planBreakdown({ doc: DOC, targets: TARGETS }, { ceiling: 5, noModel: true, ...quiet })
  if (r.kind !== 'plan') return assert.fail(r.kind)
  assert.equal(r.by, 'sections')
  assert.match(r.notes.join(' '), /No model/)
})

test('a short piece has nothing to break down', async () => {
  await fs.writeFile(path.join(root, 'essays/short.md'), '---\ntitle: Short\n---\n\nOne small paragraph.\n')
  const r = await planBreakdown({ doc: 'essays/short.md', targets: TARGETS }, { ceiling: 5, ask: never })
  assert.equal(r.kind, 'short')
})

test('below 5, creating never asks the model, and the drafts hold only the writer’s passages', async () => {
  const before = await sourceState()
  const r = await createPosts(
    {
      doc: DOC,
      posts: [
        {
          format: 'linkedin',
          angle: 'Lead with the winter',
          hook: 'I rushed my worst pages.',
          useHook: true,
          adapt: true,
          passages: ['Then I spent a winter drafting one essay a week, and the weeks that produced the worst pages were always the ones I rushed.', 'Ten growth hacks nobody wrote.'],
        },
        { format: 'x-post', passages: ['Speed gives you the first idea that arrives, and the first idea is rarely yours.'] },
      ],
    },
    { ceiling: 3, ask: never, ...quiet },
  )
  assert.equal(r.created.length, 2)
  const li = splitFrontMatter(await vault.readDoc(r.created[0].path))
  assert.equal(r.created[0].path, 'linkedin/why-slow-writing-matters-linkedin-post.md')
  // No opening at 3 (it's model wording), and the invented passage is gone.
  assert.equal(li.body.trim(), 'Then I spent a winter drafting one essay a week, and the weeks that produced the worst pages were always the ones I rushed.')
  assert.equal(li.meta['derived-from'], '[[why-slow-writing-matters]]')
  assert.equal(li.meta.from, undefined)
  assert.equal(li.meta.platform, 'linkedin')
  assert.equal(li.meta.status, 'draft')
  assert.equal(li.meta.angle, 'Lead with the winter')
  assert.equal(li.meta.target, '3000 characters')
  assert.equal(li.meta.wording, 'yours')
  assert.match(r.notes.join(' '), /isn’t in the piece/)
  assert.match(r.notes.join(' '), /needs help ceiling 5/)
  // An X post kind didn't exist: it was added, and the post filed in its folder.
  assert.deepEqual(r.addedKinds, ['X post'])
  assert.ok(r.created[1].path.startsWith('x-posts/'))
  assert.equal(splitFrontMatter(await vault.readDoc(r.created[1].path)).meta.platform, 'x-post')
  // The piece is untouched, to the byte and the mtime.
  assert.deepEqual(await sourceState(), before)
})

test('help ceiling 4: the opening line goes first only when the writer kept it', async () => {
  const r = await createPosts(
    {
      doc: DOC,
      posts: [
        { format: 'linkedin', hook: 'I rushed my worst pages.', useHook: true, passages: ['Slowness is how you get past it, to the second and third, where the strange and particular things live.'] },
        { format: 'linkedin', hook: 'I rushed my worst pages.', useHook: false, passages: ['There is a physical part to it as well.'] },
      ],
    },
    { ceiling: 4, ask: never, ...quiet },
  )
  const [a, b] = await Promise.all(r.created.map(async (c) => splitFrontMatter(await vault.readDoc(c.path))))
  assert.match(a.body, /^I rushed my worst pages\.\n\nSlowness is how/)
  assert.equal(a.meta.wording, 'yours, with a suggested opening line')
  assert.equal(b.body.trim(), 'There is a physical part to it as well.')
  // Names already taken in the folder get -2, -3: nothing is written over.
  assert.deepEqual(
    r.created.map((c) => c.path),
    ['linkedin/why-slow-writing-matters-linkedin-post-1.md', 'linkedin/why-slow-writing-matters-linkedin-post-2.md'],
  )
  const again = await createPosts({ doc: DOC, posts: [{ format: 'linkedin', passages: ['There is a physical part to it as well.'] }] }, { ceiling: 4, ask: never, ...quiet })
  assert.equal(again.created[0].path, 'linkedin/why-slow-writing-matters-linkedin-post-3.md')
})

test('a thread is made of parts that each fit, from the writer’s passages', async () => {
  const p = BODY.split('\n\n')
  const r = await createPosts({ doc: DOC, posts: [{ format: 'x-thread', passages: [p[1], p[3], p[4]] }] }, { ceiling: 2, ask: never, ...quiet })
  const body = splitFrontMatter(await vault.readDoc(r.created[0].path)).body
  const parts = threadParts(body)
  assert.ok(parts.length >= 3)
  assert.ok(parts.every((x) => xLength(x) <= 280))
  assert.equal(r.created[0].over, false)
  assert.ok(!body.includes('[^1]'))
})

test('help ceiling 5: the model adapts the wording, checked to keep the writer’s words; a draft says so', async () => {
  const before = await sourceState()
  const passages = ['Speed gives you the first idea that arrives, and the first idea is rarely yours. It is the common one, worn smooth by everyone who reached for it before you.']
  const good = fake({ text: 'Speed gives you the first idea that arrives. The first idea is rarely yours: it is the common one, worn smooth by everyone before you.' })
  const r = await createPosts({ doc: DOC, posts: [{ format: 'x-post', adapt: true, passages }] }, { ceiling: 5, ask: good.ask, ...quiet })
  const fm = splitFrontMatter(await vault.readDoc(r.created[0].path))
  assert.equal(fm.meta.wording, 'adapted by the model from yours')
  assert.match(fm.body, /^Speed gives you the first idea that arrives\. The first idea/)
  assert.match(good.calls[0].system, /Add no ideas/)

  // An "adaptation" that writes its own post is refused (after one retry): the draft keeps the writer's words.
  const bad = fake({ text: 'Unlock your creativity! Here are ten productivity hacks every writer needs to know today.' })
  const r2 = await createPosts({ doc: DOC, posts: [{ format: 'x-post', adapt: true, passages }] }, { ceiling: 5, ask: bad.ask, ...quiet })
  assert.equal(bad.calls.length, 2)
  const fm2 = splitFrontMatter(await vault.readDoc(r2.created[0].path))
  assert.equal(fm2.meta.wording, 'yours')
  assert.equal(fm2.body.trim(), passages[0])
  assert.match(r2.notes.join(' '), /couldn’t keep to your words/)
  // Over X's limit is refused too.
  const long = fake({ text: passages[0] + ' ' + passages[0] + ' ' + passages[0] })
  const r3 = await createPosts({ doc: DOC, posts: [{ format: 'x-post', adapt: true, passages }] }, { ceiling: 5, ask: long.ask, ...quiet })
  assert.equal(splitFrontMatter(await vault.readDoc(r3.created[0].path)).meta.wording, 'yours')
  assert.deepEqual(await sourceState(), before)
})

test('the piece lists its posts, and they still find it after it is renamed or moved', async () => {
  let files = await vault.listFiles()
  const derived = derivedFrom(files, DOC)
  assert.ok(derived.length >= 5)
  assert.ok(derived.every((f) => f.derivedFrom === '[[why-slow-writing-matters]]'))
  const renamed = await vault.renameDoc(DOC, 'Slow writing')
  assert.equal(renamed, 'essays/slow-writing.md')
  files = await vault.listFiles()
  assert.equal(derivedFrom(files, renamed).length, derived.length)
  assert.ok(derivedFrom(files, renamed).every((f) => f.derivedFrom === '[[slow-writing]]'))
  const moved = await vault.moveToFolder(DEFAULT_KINDS, renamed, 'archive')
  files = await vault.listFiles()
  assert.equal(derivedFrom(files, moved).length, derived.length)
})

test('a request for something that isn’t a document, or for no posts, is refused', async () => {
  await assert.rejects(planBreakdown({ doc: '../outside.md', targets: TARGETS }, { ceiling: 3 }), /Not/)
  await assert.rejects(planBreakdown({ doc: 'essays/nope.md', targets: TARGETS }, { ceiling: 3 }), /Not in the vault/)
  await assert.rejects(createPosts({ doc: 'archive/slow-writing.md', posts: [] }, { ceiling: 3 }), /No posts/)
  await assert.rejects(createPosts({ doc: 'archive/slow-writing.md', posts: [{ format: 'fax', passages: [] }] }, { ceiling: 3 }), /Unknown kind/)
})

test('an adaptation that changes nothing leaves the draft marked as the writer’s own words', async () => {
  const passages = ['There is a physical part to it as well.']
  const echo = fake({ text: 'There is a physical part to it as well.' })
  const r = await createPosts({ doc: 'archive/slow-writing.md', posts: [{ format: 'x-post', adapt: true, passages }] }, { ceiling: 5, ask: echo.ask, ...quiet })
  assert.equal(r.created[0].wording, 'yours')
  assert.doesNotMatch(r.notes.join(' '), /couldn’t keep/)
})

const SRC = 'archive/slow-writing.md'
const P2 = 'Speed gives you the first idea that arrives, and the first idea is rarely yours. It is the common one, worn smooth by everyone who reached for it before you.'
const snapshot = async () => ({ files: (await vault.listFiles()).map((f) => f.path).sort(), kinds: (await settingsMod.loadSettings()).kinds.map((k) => k.id) })

test('every post is checked before anything is written: an unknown format or no passages at all writes nothing', async () => {
  const before = await snapshot()
  await assert.rejects(
    createPosts(
      {
        doc: SRC,
        posts: [
          { format: 'short-video', passages: [P2] },
          { format: 'fax', passages: [P2] },
        ],
      },
      { ceiling: 3, ask: never },
    ),
    /Unknown kind/,
  )
  await assert.rejects(
    createPosts({ doc: SRC, posts: [{ format: 'short-video', hook: 'A line.', useHook: true, passages: ['Words that are nowhere in the piece.'] }] }, { ceiling: 4, ask: never }),
    /None of these posts/,
  )
  assert.deepEqual(await snapshot(), before)
})

test('a post with no passage from the piece is skipped with a note, never made as an empty draft', async () => {
  const r = await createPosts(
    {
      doc: SRC,
      posts: [
        { format: 'linkedin', passages: [P2] },
        { format: 'linkedin', angle: 'Empty', passages: [] },
      ],
    },
    { ceiling: 3, ask: never, ...quiet },
  )
  assert.equal(r.created.length, 1)
  assert.match(r.notes.join(' '), /One post had no passage/)
})

test('a short video files as its own kind, never as a YouTube script', async () => {
  const r = await createPosts({ doc: SRC, posts: [{ format: 'short-video', passages: [P2] }] }, { ceiling: 3, ask: never, ...quiet })
  assert.deepEqual(r.addedKinds, ['Short video script'])
  const kind = (await settingsMod.loadSettings()).kinds.find((k) => k.id === 'short-video-script')!
  assert.equal(kind.words, 150)
  assert.ok(r.created[0].path.startsWith(kind.folder + '/'))
  assert.equal(splitFrontMatter(await vault.readDoc(r.created[0].path)).meta.target, '<=150 words')
})

test('Cancel stops the model calls and nothing is written', async () => {
  const before = await snapshot()
  const ctl = new AbortController()
  let calls = 0
  const ask = async () => {
    calls++
    ctl.abort()
    return JSON.stringify({ text: P2 })
  }
  await assert.rejects(
    createPosts({ doc: SRC, posts: Array.from({ length: 4 }, () => ({ format: 'linkedin', adapt: true, passages: [P2] })) }, { ceiling: 5, ask, signal: ctl.signal, ...quiet }),
    (e) => e instanceof Cancelled,
  )
  assert.equal(calls, 1)
  assert.deepEqual(await snapshot(), before)
})

test('help ceiling 6 (whole drafts): an opening and a close of its own are allowed, invented content is not', async () => {
  const whole = fake({ text: 'Something I learned the slow way, one winter. ' + P2 + ' So take your time.' })
  const r = await createPosts({ doc: SRC, posts: [{ format: 'linkedin', adapt: true, passages: [P2] }] }, { ceiling: 6, ask: whole.ask, ...quiet })
  assert.equal(r.created[0].wording, 'adapted by the model from yours')
  assert.match(whole.calls[0].system, /short opening and a short close/)
  // The same at 5 is refused: too many words of its own in a row.
  const at5 = await createPosts({ doc: SRC, posts: [{ format: 'linkedin', adapt: true, passages: [P2] }] }, { ceiling: 5, ask: whole.ask, ...quiet })
  assert.equal(at5.created[0].wording, 'yours')
  const invent = fake({ text: 'Productivity is a myth sold by gurus who want your attention, and the best writers ignore every trend and every hack. ' + P2 })
  const r6 = await createPosts({ doc: SRC, posts: [{ format: 'linkedin', adapt: true, passages: [P2] }] }, { ceiling: 6, ask: invent.ask, ...quiet })
  assert.equal(r6.created[0].wording, 'yours')
})

test('a long angle is cut short, not dropped', () => {
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  const a = cleanAngle(long)
  assert.ok(a.startsWith('word0 word1') && a.endsWith('…'))
  assert.ok(a.split(' ').length <= 25)
})

test('Obsidian comments never reach the model, and a long piece says how much the model read', async () => {
  const paras = Array.from(
    { length: 300 },
    (_, i) =>
      `Paragraph ${i} %%secret note ${i}%% says one plain thing about the craft of writing slowly, at some length, so the piece is long. It says it twice, to be sure the piece runs past what the model reads.`,
  )
  await fs.writeFile(path.join(root, 'essays/long.md'), `---\ntitle: Long\n---\n\n${paras.join('\n\n')}\n`)
  const m = fake(PLAN)
  const r = await planBreakdown({ doc: 'essays/long.md', targets: TARGETS }, { ceiling: 3, ask: m.ask, ...quiet })
  assert.doesNotMatch(m.calls[0].prompt, /secret/)
  if (r.kind !== 'plan') return assert.fail(r.kind)
  assert.match(r.notes.join(' '), /read only the first \d+ of its 300 paragraphs/)
})

test('a note with its own `from:` property (an email’s sender) is not a post drawn from anything', async () => {
  await fs.writeFile(path.join(root, 'essays/letter.md'), '---\ntitle: Letter\nfrom: "[[slow-writing]]"\n---\n\nHi.\n')
  const files = await vault.listFiles()
  assert.ok(!derivedFrom(files, SRC).some((f) => f.path === 'essays/letter.md'))
})
