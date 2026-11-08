import test from 'node:test'
import assert from 'node:assert/strict'
import {
  derivedFrom,
  findPassage,
  fit,
  formatsFor,
  findFormat,
  kindFor,
  ownWords,
  adaptationProblems,
  wordList,
  withoutComments,
  asMarkdown,
  unescapeMarkdown,
  quotedBody,
  resolveWikiLink,
  sectionPlan,
  sentencesOf,
  splitToFit,
  threadParts,
  tooShort,
  unitsOf,
  wikiLinkTo,
  PART_MARKER,
} from './breakdown.ts'
import { DEFAULT_KINDS } from './kinds.ts'
import { xLength, linkedinLength } from './targets.ts'

const PIECE_COMMENTS = `Before %%a private aside%% after.\n\n%%\nA whole private block\n%%\n\n%% part %%\n\nThe end. %%unclosed note to the end`

const PIECE = `# The unfinished room

I kept a room in the house unfinished for six years. Paint samples on one wall, a ladder in the corner.[^1]

![the room](room.jpg)

## Why I left it

Finishing it felt like closing a question I still wanted to ask. Every time I walked past, I thought about who I would be once it was done.

- A list item with [[on-craft|my notes on craft]] in it.

| a | b |
|---|---|
| table | cell |

## What it taught me

The room taught me that **unfinished** is a place, not a delay. You can live in it, and you can [write about it](https://example.com/room).

[^1]: The ladder is still there.
`

test('a piece reads as plain paragraphs under their headings: no marks, footnotes, pictures or tables', () => {
  const units = unitsOf(PIECE)
  assert.deepEqual(
    units.map((u) => u.heading),
    ['The unfinished room', 'Why I left it', 'Why I left it', 'What it taught me'],
  )
  assert.equal(units[0].text, 'I kept a room in the house unfinished for six years. Paint samples on one wall, a ladder in the corner.')
  assert.equal(units[2].text, 'A list item with my notes on craft in it.')
  assert.equal(units[3].text, 'The room taught me that unfinished is a place, not a delay. You can live in it, and you can write about it (https://example.com/room).')
  assert.ok(!units.some((u) => /ladder is still there|table|room\.jpg/.test(u.text)))
})

test('a short piece has nothing to break down; an empty one says so', () => {
  assert.match(tooShort(unitsOf('Just one paragraph, not much else.'))!, /short enough to post as it is/)
  assert.match(tooShort([])!, /no text/)
  const long = Array.from({ length: 4 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(40)).join('\n\n')
  assert.equal(tooShort(unitsOf(long)), null)
  // Chinese has no spaces: words are counted per word, not per run of text.
  const zh = Array.from({ length: 8 }, () => '我每天早上写作，因为安静的时候思路最清楚。慢慢写，才能写出自己的话。').join('\n\n')
  assert.equal(tooShort(unitsOf(zh)), null)
})

test('a passage is the paragraph’s own words, found with quotes and spacing folded; anything else is refused', () => {
  const units = unitsOf(`It's a "small" room.\n\nAnother   paragraph here.`)
  assert.deepEqual(findPassage(units, 'It’s a “small” room.'), { unit: 1, text: `It's a "small" room.` })
  assert.deepEqual(findPassage(units, 'Another paragraph here.'), { unit: 2, text: 'Another paragraph here.' })
  assert.equal(findPassage(units, 'A sentence the model made up.'), null)
  assert.equal(findPassage(units, '  '), null)
})

test('X counts links as 23 and wide scripts as 2; LinkedIn counts what the reader sees', () => {
  assert.equal(xLength('hello'), 5)
  assert.equal(xLength('see https://example.com/a/very/long/path/indeed'), 4 + 23)
  assert.equal(xLength('写作'), 4)
  assert.equal(linkedinLength('  hi 👋🏽  '), 4)
})

test('a thread splits long passages at sentence ends, every part within 280, in the writer’s words', () => {
  const thread = findFormat(DEFAULT_KINDS, 'x-thread')!
  const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} says one small true thing about writing.`).join(' ')
  const body = quotedBody(thread, [long, 'A second passage.'], 'My opening line.')
  const parts = threadParts(body)
  assert.ok(body.includes(PART_MARKER))
  assert.equal(parts[0], 'My opening line.')
  assert.equal(parts[parts.length - 1], 'A second passage.')
  assert.ok(parts.every((p) => xLength(p) <= 280))
  assert.equal(parts.slice(1, -1).join(' '), long)
  assert.equal(fit(thread, body).over, false)
})

test('CJK sentences split at their own stops and join without a space', () => {
  const zh = '我每天早上写作。安静的时候思路最清楚！慢慢写，才能写出自己的话？'
  assert.equal(sentencesOf(zh).length, 3)
  const parts = splitToFit(zh, 20, xLength)
  assert.ok(parts.length > 1)
  assert.equal(parts.join(''), zh)
})

test('Markdown-looking lines in a passage stay plain text', () => {
  const post = findFormat(DEFAULT_KINDS, 'linkedin')!
  assert.equal(quotedBody(post, ['# not a heading', '- not a list']), '\\# not a heading\n\n\\- not a list')
})

test('a plan from the sections uses only the writer’s passages and keeps short posts within their limit', () => {
  const units = unitsOf(PIECE)
  const plan = sectionPlan(
    units,
    [
      { format: 'x-post', count: 2 },
      { format: 'linkedin', count: 1 },
    ],
    DEFAULT_KINDS,
  )
  assert.equal(plan.length, 3)
  assert.deepEqual(
    plan.map((p) => p.format),
    ['x-post', 'x-post', 'linkedin'],
  )
  for (const p of plan) {
    assert.ok(p.passages.length)
    for (const q of p.passages) assert.ok(units.find((u) => u.id === q.unit)!.text.includes(q.text))
  }
  const x = findFormat(DEFAULT_KINDS, 'x-post')!
  for (const p of plan.filter((p) => p.format === 'x-post')) assert.ok(xLength(p.passages.map((q) => q.text).join('\n\n')) <= 282)
  assert.equal(plan[0].angle, 'The unfinished room')
  assert.ok(fit(x, plan[0].passages[0].text).length <= 280)
})

test('formats: the built-in ones file into the writer’s kinds, and the other kinds are offered too', () => {
  const fs = formatsFor(DEFAULT_KINDS)
  assert.equal(
    kindFor(
      fs.find((f) => f.id === 'linkedin')!,
      DEFAULT_KINDS,
    )?.id,
    'linkedin',
  )
  assert.equal(
    kindFor(
      fs.find((f) => f.id === 'x-post')!,
      DEFAULT_KINDS,
    ),
    undefined,
  )
  assert.equal(
    kindFor(
      fs.find((f) => f.id === 'short-video')!,
      DEFAULT_KINDS,
    )?.id,
    undefined,
  )
  assert.ok(fs.some((f) => f.id === 'kind:email'))
  assert.ok(!fs.some((f) => f.id === 'kind:essay' || f.id === 'kind:linkedin'))
})

test('a post links to its piece by name, by path when the name is shared, and still finds it after a move', () => {
  const paths = ['essays/the-room.md', 'linkedin/the-room-post.md']
  assert.equal(wikiLinkTo(paths, 'essays/the-room.md'), '[[the-room]]')
  assert.equal(wikiLinkTo([...paths, 'notes/the-room.md'], 'essays/the-room.md'), '[[essays/the-room]]')
  assert.equal(resolveWikiLink(paths, '[[the-room]]'), 'essays/the-room.md')
  assert.equal(resolveWikiLink(paths, '[[the-room|alias]]'), 'essays/the-room.md')
  assert.equal(resolveWikiLink(paths, '[[essays/the-room#Heading]]'), 'essays/the-room.md')
  assert.equal(resolveWikiLink(paths, 'the-room'), null)
  // Moved to another folder: the name still finds it.
  const files = [
    { path: 'archive/the-room.md' },
    { path: 'linkedin/a.md', derivedFrom: '[[the-room]]' },
    { path: 'x-posts/b.md', derivedFrom: '[[the-room]]' },
    { path: 'x-posts/c.md', derivedFrom: '[[something-else]]' },
  ]
  assert.deepEqual(
    derivedFrom(files, 'archive/the-room.md').map((f) => f.path),
    ['linkedin/a.md', 'x-posts/b.md'],
  )
  // Non-Latin names resolve too.
  assert.equal(resolveWikiLink(['essays/慢写.md'], '[[慢写]]'), 'essays/慢写.md')
})

test('Obsidian comments are private: never planned from, inline, across lines or unclosed', () => {
  const units = unitsOf(PIECE_COMMENTS)
  assert.deepEqual(
    units.map((u) => u.text),
    ['Before after.', 'The end.'],
  )
  assert.equal(withoutComments('a %% b %% c'), 'a  c')
  assert.ok(!units.some((u) => /private|part|unclosed/.test(u.text)))
})

test('a passage never starts or ends inside a word, and is a phrase at least', () => {
  const units = unitsOf('Every category of writing has its own rhythm and its own reader.\n\nShort.')
  assert.deepEqual(findPassage(units, 'ategory of writing has'), { unit: 1, text: 'category of writing has' })
  assert.deepEqual(findPassage(units, 'writing has its own rhyt'), { unit: 1, text: 'writing has its own rhythm' })
  assert.equal(findPassage(units, 'its own'), null)
  // A one-word paragraph can still be taken whole.
  assert.deepEqual(findPassage(units, 'Short.'), { unit: 2, text: 'Short.' })
  // CJK snaps to words too.
  const zh = unitsOf('我每天早上写作，因为安静的时候思路最清楚。')
  const found = findPassage(zh, '天早上写作，因为安静')
  assert.ok(found && found.text.startsWith('每天') && found.text.endsWith('安静'))
})

test('plain text stays plain in a draft: emphasis, brackets and HTML are escaped, inline code is kept', () => {
  assert.equal(asMarkdown('a *literal* [x] <b> under_score'), 'a \\*literal\\* \\[x\\] \\<b\\> under\\_score')
  assert.equal(asMarkdown('run `npm *test*` now'), 'run `npm *test*` now')
  assert.equal(asMarkdown('1. not a list'), '1\\. not a list')
  assert.equal(unescapeMarkdown(asMarkdown('a *b* [c] 1. d')), 'a *b* [c] 1. d')
  const units = unitsOf('Use `git log` and *stars* often, every single day of the week.\n\nMore words here for the piece.')
  assert.equal(units[0].text, 'Use `git log` and stars often, every single day of the week.')
  const post = findFormat(DEFAULT_KINDS, 'linkedin')!
  // Lengths count what the reader sees, not the escapes.
  assert.equal(fit(post, asMarkdown('a *b*')).length, 5)
})

test('only kinds that can only mean the platform are matched: no YouTube script for a short, no "thread" for X', () => {
  const kinds = [...DEFAULT_KINDS, { id: 'thread', name: 'Thread', folder: 'threads', guidance: '', words: 300 }, { id: 'shorts', name: 'Shorts', folder: 'shorts', guidance: '', words: 50 }]
  const fs = formatsFor(kinds)
  assert.equal(
    kindFor(
      fs.find((f) => f.id === 'short-video')!,
      kinds,
    ),
    undefined,
  )
  assert.equal(
    kindFor(
      fs.find((f) => f.id === 'x-post')!,
      kinds,
    ),
    undefined,
  )
  assert.ok(fs.some((f) => f.id === 'kind:thread') && fs.some((f) => f.id === 'kind:shorts') && fs.some((f) => f.id === 'kind:youtube-script'))
})

const PASSAGE = 'Speed gives you the first idea that arrives, and the first idea is rarely yours. It is the common one, worn smooth by everyone who reached for it before you.'

test('an adaptation counts as the writer’s only in runs of their words, in their order', () => {
  // Cut and joined: theirs.
  assert.equal(adaptationProblems('Speed gives you the first idea that arrives. The first idea is rarely yours: it is the common one, worn smooth by everyone.', [PASSAGE], 'passages').length, 0)
  // Their words scrambled into a new claim: not theirs, however many words match.
  const scrambled = 'Everyone who reached for the common idea arrives first, and speed is rarely smooth: it gives you yours before it.'
  assert.ok(ownWords(scrambled, [PASSAGE]).share < 0.4)
  assert.ok(adaptationProblems(scrambled, [PASSAGE], 'passages').length)
  // A pitch in front of the passage: too many of the model's words in a row.
  const pitch = 'Buy my course at the link now because ' + PASSAGE
  assert.ok(ownWords(pitch, [PASSAGE]).share > 0.75)
  assert.match(adaptationProblems(pitch, [PASSAGE], 'passages').join(' '), /in a row of its own/)
  // Repeating a line doesn't count twice.
  const twice = ownWords('the first idea is rarely yours, the first idea is rarely yours', ['the first idea is rarely yours'])
  assert.equal(twice.foreign, 6)
  // Little words in the same order don't count as theirs.
  assert.equal(ownWords('and the of', ['and the of something']).foreign, 3)
})

test('whole drafts may add an opening and a close, but the body stays the writer’s', () => {
  const opened = 'Here is something I learned the slow way, over one long winter. ' + PASSAGE + ' So take your time.'
  assert.match(adaptationProblems(opened, [PASSAGE], 'passages').join(' '), /in a row/)
  assert.equal(adaptationProblems(opened, [PASSAGE], 'whole').length, 0)
  const invented = 'Productivity is a myth sold by people who want your attention, and the best writers I know ignore every trend, hack and guru completely.'
  assert.ok(adaptationProblems(invented, [PASSAGE], 'whole').length)
})

test('without a word segmenter, CJK counts character by character, so runs still mean something', () => {
  assert.deepEqual(wordList('我写作 slowly', null), ['我', '写', '作', 'slowly'])
  assert.ok(ownWords('安静的时候思路最清楚', ['因为安静的时候思路最清楚。']).share > 0.9)
})
