// Accepting the assistant's proposals on the page: exactly what was proposed goes in, formatting as
// formatting (never as `**` saved as `\*\*`), several at once in the right places, and nothing else changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSchema } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { extensions } from './schema.ts'
import { carryGaps, parseMarkdown, serializeMarkdown } from './markdown.ts'
import { textMap, type Hunk } from './help.ts'
import { acceptedEdits, applyEdits, applyFormat, mergeEq, pageMarkdown, partHunks, refusedFormats, richOf } from './format.ts'
import { applyAll, checkProposals, rebase, relocate, type Proposal } from '../lib/assistant.ts'
import { readAsk } from '../lib/scope.ts'

const schema = getSchema(extensions())

/** The page's text and its document positions, as the Assistant tab reads them. */
function page(doc: ReturnType<typeof parseMarkdown>['doc']) {
  const map = textMap(doc, 0, doc.content.size)
  const endOf = (o: number) => (o > 0 && o >= map.text.length ? map.pos(map.text.length - 1) + 1 : map.pos(o))
  return { ...map, endOf }
}

/**
 * Ask-and-accept, end to end as the tab and the page do it: the model's changes are checked against the page
 * text, put on the page as one diff, decided (all accepted unless `decide` says otherwise), applied, and saved.
 */
function accept(
  md: string,
  changes: { find: string; replace: string }[],
  opts: { level?: number; ask?: string; decide?: (h: Hunk & { kind: 'chg' }, i: number) => 'accepted' | 'rejected'; pick?: (p: Proposal[]) => Proposal[] } = {},
) {
  const { doc, source } = parseMarkdown(schema, md)
  const p = page(doc)
  // Asked to format, unless the test says what was asked.
  const { proposals, dropped } = checkProposals(changes, p.text, { level: opts.level ?? 5, ask: readAsk(opts.ask ?? 'format this') })
  const list = opts.pick ? opts.pick(proposals) : proposals
  if (!list.length) return { out: md, proposals, dropped, hunks: [] as Hunk[], doc, refused: [] as number[] }
  const span = applyAll(
    p.text,
    list.map((x) => ({ start: x.start, end: x.end, replace: x.replace })),
  )!
  const from = p.pos(span.start)
  const to = span.end > span.start ? p.endOf(span.end) : p.pos(span.end)
  assert.equal(textMap(doc, from, to).text, span.original, 'the span on the page is the span of the text')
  let n = 0
  const hunks = partHunks(
    schema,
    span.original,
    list.map((x, index) => ({ start: x.start - span.start, end: x.end - span.start, replace: x.replace, format: x.format, index })),
  ).map((h) => (h.kind === 'chg' ? { ...h, state: opts.decide ? opts.decide(h, n++) : ('accepted' as const) } : h))
  const state = EditorState.create({ schema, doc })
  // As the page does before showing them: formatting that wouldn't go in exactly as proposed is left out.
  const refused = refusedFormats(state.tr, from, to, hunks)
  const shown = mergeEq(hunks.map((h) => (h.kind === 'chg' && h.part !== undefined && refused.includes(h.part) ? { kind: 'eq' as const, text: h.del } : h)))
  const tr = state.tr
  assert.equal(applyEdits(tr, acceptedEdits(doc, { from, to, hunks: shown }, 'rejected').edits), 0, 'every change shown goes in')
  const next = state.apply(tr)
  carryGaps(state.doc, next.doc, source)
  // Undo is one step: every change is in this one transaction, and inverting it gives back the page as it was.
  let back = next.doc
  for (let i = tr.steps.length - 1; i >= 0; i--) back = tr.steps[i].invert(tr.docs[i]).apply(back).doc!
  assert.ok(back.eq(doc), 'undo gives back the page')
  return { out: serializeMarkdown(next.doc, source), proposals, dropped, hunks, doc: next.doc, refused }
}

test('bold proposed in Markdown goes in as bold, not as stars', () => {
  const { out, proposals } = accept('The result? The urgent work always won.\n', [{ find: 'The urgent work always won.', replace: 'The **urgent work** always won.' }])
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].format, true)
  assert.equal(out, 'The result? The **urgent work** always won.\n')
  assert.doesNotMatch(out, /\\\*/)
})

test('the two "**" of one phrase are one change, even when the model sends them as two', () => {
  const text = 'For three years I optimised every minute of my day. I tracked my habits.\n'
  const { out, proposals } = accept(text, [
    { find: 'I optimised', replace: 'I **optimised' },
    { find: 'minute of my', replace: 'minute** of my' },
  ])
  assert.equal(proposals.length, 1)
  assert.equal(out, 'For three years I **optimised every minute** of my day. I tracked my habits.\n')
})

test('formatting the model could not see is kept: bold stays bold when a phrase is made italic', () => {
  const { out } = accept('Some **bold** text and a phrase here.\n', [{ find: 'a phrase here', replace: '*a phrase* here' }])
  assert.equal(out, 'Some **bold** text and *a phrase* here.\n')
})

test('a heading, a list and a link', () => {
  const md = 'What changed\n\nThree things I learned:\nFirst, less is more.\nSecond, mornings matter.\n\nRead my blog for more.\n'
  const { out } = accept(md, [
    { find: 'What changed', replace: '## What changed' },
    { find: 'Three things I learned:\nFirst, less is more.\nSecond, mornings matter.', replace: 'Three things I learned:\n\n- First, less is more.\n- Second, mornings matter.' },
    { find: 'my blog', replace: '[my blog](https://example.com/blog)' },
  ])
  assert.equal(out, '## What changed\n\nThree things I learned:\n\n- First, less is more.\n- Second, mornings matter.\n\nRead [my blog](https://example.com/blog) for more.\n')
})

test('a numbered list, and italics inside a heading the page already has', () => {
  const { out } = accept('# Why slow writing\n\nOne, think.\nTwo, write.\n', [
    { find: 'Why slow writing', replace: 'Why *slow* writing' },
    { find: 'One, think.\nTwo, write.', replace: '1. One, think.\n2. Two, write.' },
  ])
  assert.equal(out, '# Why *slow* writing\n\n1. One, think.\n2. Two, write.\n')
})

test('a paragraph already in a list, proposed as a list item, stays one item of the same list', () => {
  const { out } = accept('- First\n- Second\n- Third\n', [{ find: 'Second', replace: '- **Second**' }])
  assert.equal(out, '- First\n- **Second**\n- Third\n')
})

test('a heading the model saw as plain text stays a heading when it bolds a word in it', () => {
  const { out } = accept('## The problem\n\nBody text.\n', [{ find: 'The problem', replace: 'The **real** problem' }])
  assert.equal(out, '## The **real** problem\n\nBody text.\n')
})

test('Accept all: plain and formatting changes together, each in its place, in any order', () => {
  const md = 'Why I stopped 🚀\n\nI was busier than ever, and my writing got worse 📚.\n\nGuard your best hours. 💡\n'
  const changes = [
    { find: 'Guard your best hours. 💡', replace: 'Guard **your best hours**.' },
    { find: 'Why I stopped 🚀', replace: 'Why I stopped' },
    { find: 'my writing got worse 📚.', replace: '**my writing got worse**.' },
  ]
  const { out, proposals } = accept(md, changes)
  assert.equal(proposals.length, 3)
  assert.equal(out, 'Why I stopped\n\nI was busier than ever, and **my writing got worse**.\n\nGuard **your best hours**.\n')
})

test('the real "format this document" answer: headings, bold and a list, with no stars or backslashes left', () => {
  const md =
    '# Accept test\n\nWhy I stopped chasing productivity 🚀\n\nFor three years I optimised every minute of my day.\n\nWhat changed: I started protecting two hours each morning for deep work.\n\nThree things I learned:\nFirst, less is more.\nSecond, mornings matter.\nThird, rest is part of the work.\n'
  // As the model sent them, cut to their smallest pieces (as minimalChanges cut them).
  const { out } = accept(md, [
    { find: 'Why I stopped chasing productivity 🚀', replace: '# Why I stopped chasing productivity 🚀\n\n## The problem' },
    { find: 'For three years I optimised every minute of my day.', replace: 'For three years I **optimised every minute** of my day.' },
    { find: 'What changed: I started protecting two hours each morning', replace: '## What changed\n\nI started protecting **two hours each morning**' },
    {
      find: 'Three things I learned:\nFirst, less is more.\nSecond, mornings matter.\nThird, rest is part of the work.',
      replace: '## Three things I learned\n- First, less is more.\n- Second, mornings matter.\n- Third, rest is part of the work.',
    },
  ])
  assert.equal(
    out,
    '# Accept test\n\n# Why I stopped chasing productivity 🚀\n\n## The problem\n\nFor three years I **optimised every minute** of my day.\n\n## What changed\n\nI started protecting **two hours each morning** for deep work.\n\n## Three things I learned\n\n- First, less is more.\n- Second, mornings matter.\n- Third, rest is part of the work.\n',
  )
  assert.doesNotMatch(out, /\\[*#-]/)
})

test('deciding one by one on the page: only the accepted changes go in', () => {
  const md = 'One 🚀 two.\n\nThree four 📚 five.\n\nSix seven.\n'
  const { out } = accept(
    md,
    [
      { find: 'One 🚀 two.', replace: 'One two.' },
      { find: 'four 📚 five', replace: 'four five' },
      { find: 'Six seven.', replace: '**Six** seven.' },
    ],
    { decide: (_h, i) => (i === 1 ? 'rejected' : 'accepted') },
  )
  assert.equal(out, 'One two.\n\nThree four 📚 five.\n\n**Six** seven.\n')
})

test('plain changes still go in as text, and text that only looks like Markdown is left as text', () => {
  const { out, doc, proposals } = accept('In 1990. A good year.\n\nIt was 5 * 3 * 2.\n', [
    { find: 'A good year.', replace: 'A great year.' },
    { find: '5 * 3 * 2', replace: '5 * 3 * 2 = 30' },
  ])
  assert.ok(proposals.every((p) => !p.format))
  // On the page: the stars as typed, as text. The file escapes them so they read back as text.
  assert.equal(page(doc).text, 'In 1990. A great year.\n\nIt was 5 * 3 * 2 = 30.')
  assert.equal(page(parseMarkdown(schema, out).doc).text, page(doc).text)
})

test('formatting a paragraph fits help level 3 when it changes no words; a mechanical ask flags it', () => {
  const md = 'We shipped it 🚀 and it was hard work for all of us.\n'
  const three = accept(md, [{ find: 'it was hard work', replace: 'it was **hard work**' }], { level: 3 })
  assert.equal(three.proposals.length, 1)
  assert.equal(three.out, 'We shipped it 🚀 and it was **hard work** for all of us.\n')
  // "Remove the emojis" didn't ask for bold: the change is marked, and only-what-was-asked is plain text.
  const { proposals } = accept(md, [{ find: 'We shipped it 🚀 and it was hard work', replace: 'We shipped it and it was **hard work**' }], { ask: 'remove the emojis' })
  assert.equal(proposals.length, 1)
  assert.match(proposals[0].beyond ?? '', /formatting/)
  assert.equal(proposals[0].narrow, 'We shipped it and it was hard work for all of us.')
  // Asked for both, it is within the ask.
  const both = accept(md, [{ find: 'We shipped it 🚀 and it was hard work', replace: 'We shipped it and it was **hard work**' }], { ask: 'remove the emojis and bold the key phrase' })
  assert.equal(both.proposals[0].beyond, undefined)
  assert.equal(both.out, 'We shipped it and it was **hard work** for all of us.\n')
})

test('accepting one change after another: the rest are found where the text now is, insertions too', () => {
  const text = 'Alpha beta gamma delta.\n\nEpsilon zeta.'
  const proposals: Proposal[] = [
    { id: 'p1', start: 6, end: 6, find: '', replace: 'very ', before: 'Alpha ', after: 'beta gamma delta.\n\nEpsil' },
    { id: 'p2', start: 11, end: 11, find: '', replace: 'nice ', before: 'Alpha beta ', after: 'gamma delta.\n\nEpsilon ze' },
    { id: 'p3', start: 25, end: 32, find: 'Epsilon', replace: 'Eta', before: 'Alpha beta gamma delta.\n\n', after: ' zeta.' },
  ]
  // p1 accepted: the page changes under p2 and p3.
  const now = text.slice(0, 6) + 'very ' + text.slice(6)
  // An insertion is found by the text around it after an edit elsewhere; right next to the edit, it needs moving with it.
  assert.deepEqual(relocate('New opening. ' + text, proposals[1]), { start: 24, end: 24 })
  assert.equal(relocate(now, proposals[1]), null)
  const moved = rebase(text, now, proposals)
  assert.deepEqual(
    moved.slice(1).map((p) => [p.start, p.end]),
    [
      [16, 16],
      [30, 37],
    ],
  )
  assert.deepEqual(relocate(now, moved[1]), { start: 16, end: 16 })
  assert.deepEqual(relocate(now, moved[2]), { start: 30, end: 37 })
  // A proposal whose own text changed is left alone, and is not found.
  const gone = now.replace('Epsilon', 'Omega')
  assert.equal(rebase(now, gone, moved)[2].start, 30)
  assert.equal(relocate(gone, moved[2]), null)
})

test('a change is still found after the writer edits right beside it, on one side', () => {
  const text = 'Third, rest is part of the work.\n\nGuard your best hours. Always.'
  const p = { start: 34, end: 56, find: 'Guard your best hours.', before: 'rest is part of the work.\n\n', after: ' Always.' }
  assert.deepEqual(relocate(text, p), { start: 34, end: 56 })
  const edited = text.replace('the work.', 'the work. Truly.')
  assert.deepEqual(relocate(edited, p), { start: 41, end: 63 })
  // Edited on both sides, and the same words elsewhere: it can't be told, so it isn't guessed.
  const both = 'Guard your best hours. ' + edited.replace(' Always.', ' Never.')
  assert.equal(relocate(both, p), null)
})

test("the writer's own text is never read as Markdown: stars, a numbered start and a hash stay text", () => {
  // As the file has them (escaped), so the page shows "2*3*4".
  const stars = accept('2\\*3\\*4 and it matters a lot.\n', [{ find: '2*3*4 and it matters a lot.', replace: '2*3*4 and **it matters** a lot.' }])
  assert.equal(page(stars.doc).text, '2*3*4 and it matters a lot.')
  assert.match(stars.out, /\*\*it matters\*\*/)
  assert.equal(page(parseMarkdown(schema, stars.out).doc).text, '2*3*4 and it matters a lot.')
  // Bold where the model put it, and nowhere else.
  let bold = ''
  stars.doc.descendants((n) => {
    if (n.isText && n.marks.length) bold += `[${n.text}:${n.marks.map((m) => m.type.name).join()}]`
  })
  assert.equal(bold, '[it matters:bold]')

  const year = accept('1990\\. A good year for wine.\n', [{ find: 'A good year', replace: 'A **good** year' }])
  assert.equal(year.doc.firstChild!.type.name, 'paragraph')
  assert.equal(page(year.doc).text, '1990. A good year for wine.')

  const hash = accept('\\# not heading but text here ok.\n', [{ find: 'text here', replace: '*text* here' }])
  assert.equal(hash.doc.firstChild!.type.name, 'paragraph')
  assert.equal(page(hash.doc).text, '# not heading but text here ok.')
})

test('a page link in a formatted paragraph stays a page link; one whose words the change touches is refused', () => {
  const md = 'See [[Other Note]] for more, and this matters.\n'
  const kept = accept(md, [{ find: 'and this matters', replace: 'and **this matters**' }])
  assert.equal(kept.out, 'See [[Other Note]] for more, and **this matters**.\n')
  let links = 0
  kept.doc.descendants((n) => void (n.type.name === 'pageLink' && links++))
  assert.equal(links, 1)
  const touched = accept(md, [{ find: 'Other Note', replace: '**Other Note**' }])
  assert.deepEqual(touched.refused, [0])
  assert.equal(touched.out, md)
})

test("the writer's words put in inline code read exactly as written", () => {
  const r = accept(
    'Call foo.bar() here, then run npm-test on snake_case_name.\n',
    [{ find: 'Call foo.bar() here, then run npm-test on snake_case_name.', replace: 'Call `foo.bar()` here, then run `npm-test` on `snake_case_name`.' }],
    { ask: 'put the code in code formatting' },
  )
  assert.deepEqual(r.refused, [])
  assert.equal(r.out, 'Call `foo.bar()` here, then run `npm-test` on `snake_case_name`.\n')
  assert.equal(page(r.doc).text, 'Call foo.bar() here, then run npm-test on snake_case_name.')
})

test("a change that wouldn't read as proposed is refused, not half applied", () => {
  // A page link put inside inline code would lose the link: refused on the page, and the page left as it was.
  const r = accept('See [[Other Note]] now.\n', [{ find: 'See Other Note now.', replace: 'See `Other Note` now.' }], { ask: 'put it in code formatting' })
  assert.deepEqual(r.refused, [0])
  assert.equal(r.out, 'See [[Other Note]] now.\n')
  const { doc } = parseMarkdown(schema, 'Some text.\n')
  const tr = EditorState.create({ schema, doc }).tr
  assert.equal(applyFormat(tr, 1, 11, pageMarkdown('Some text.', '![x](https://example.com/p.png) Some text.')), false)
  assert.equal(tr.docChanged, false)
})

test('formatting is held to the level and the ask: no images, rules or joined paragraphs on "tighten" at level 3', () => {
  const md = 'First paragraph here.\n\nSecond paragraph here.\n'
  const image = accept(md, [{ find: 'First paragraph here.', replace: 'First paragraph here. ![x](https://evil.example/p.png)' }], { level: 3, ask: 'tighten' })
  assert.deepEqual(image.proposals, [])
  assert.equal(image.dropped[0].reason, 'formatting it can’t add')
  const rule = accept(md, [{ find: 'First paragraph here.', replace: 'First paragraph here.\n\n---' }], { level: 3, ask: 'tighten' })
  assert.deepEqual(rule.proposals, [])
  const joined = accept(md, [{ find: 'First paragraph here.\n\nSecond paragraph here.', replace: '**First** paragraph here. Second paragraph here.' }], { level: 3, ask: 'tighten' })
  assert.deepEqual(joined.proposals, [])
  assert.equal(joined.dropped[0].reason, 'over the help ceiling')
  // Raw HTML, and a heading or list nobody asked for, are refused too.
  assert.deepEqual(accept(md, [{ find: 'First paragraph', replace: '<b>First</b> paragraph' }], { ask: 'make it bold' }).proposals, [])
  assert.deepEqual(accept(md, [{ find: 'First paragraph here.', replace: '## First paragraph here.' }], { ask: 'make it bold' }).proposals, [])
  // An image never reaches the page's preview either.
  assert.equal(richOf(schema, 'a ![x](https://evil.example/p.png) b').fragment.firstChild!.childCount, 1)
})

test("formatting on an ask that isn't for formatting is flagged, and taking only what was asked leaves it out", () => {
  const { proposals } = accept('The intro is long and slow to start.\n', [{ find: 'The intro is long and slow to start.', replace: 'The intro is **slow**.' }], { ask: 'tighten the intro' })
  assert.match(proposals[0].beyond ?? '', /formatting/)
  assert.equal(proposals[0].narrow, 'The intro is slow.')
  assert.equal(readAsk('shorten this list of hooks').formatting, undefined)
  assert.equal(readAsk('the link in line two is broken').formatting, undefined)
  assert.equal(readAsk('make it a list').formatting, 'all')
  for (const ask of ['make the title a heading', 'number these steps', 'add some structure', 'structure this better', 'make this more scannable', 'outline it with headings'])
    assert.equal(readAsk(ask).formatting, 'all', ask)
  for (const ask of ['the bold claim in line two is weak', 'make this list shorter', 'the structure of the argument is weak', 'the heading is weak'])
    assert.equal(readAsk(ask).formatting, undefined, ask)
  assert.equal(readAsk('please highlight the key points').formatting, 'inline')
  assert.equal(readAsk('add links to the sources').formatting, 'inline')
})

test("an empty side of a change's surroundings only matches at the start or end of the page", () => {
  const p = { start: 6, end: 11, find: 'world', before: 'Hello ', after: '' }
  assert.deepEqual(relocate('Hi, hello there world', p), { start: 16, end: 21 })
  assert.equal(relocate('Hi world, and more', p), null)
})
