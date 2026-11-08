import test from 'node:test'
import assert from 'node:assert/strict'
import {
  derivedFrom,
  findPassage,
  fit,
  formatsFor,
  findFormat,
  kindFor,
  ownShare,
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
  assert.deepEqual(findPassage(units, 'Another paragraph'), { unit: 2, text: 'Another paragraph' })
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
    'youtube-script',
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
  const files = [{ path: 'archive/the-room.md' }, { path: 'linkedin/a.md', from: '[[the-room]]' }, { path: 'x-posts/b.md', from: '[[the-room]]' }, { path: 'x-posts/c.md', from: '[[something-else]]' }]
  assert.deepEqual(
    derivedFrom(files, 'archive/the-room.md').map((f) => f.path),
    ['linkedin/a.md', 'x-posts/b.md'],
  )
  // Non-Latin names resolve too.
  assert.equal(resolveWikiLink(['essays/慢写.md'], '[[慢写]]'), 'essays/慢写.md')
})

test('an adaptation’s share of the writer’s own words', () => {
  const passages = ['Slow writing gets you past the first idea, which is rarely yours.']
  assert.ok(ownShare('Slow writing gets you past the first idea. The first idea is rarely yours.', passages) > 0.9)
  assert.ok(ownShare('Unlock your productivity with these ten amazing growth hacks today.', passages) < 0.3)
})
