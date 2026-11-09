// Formatting in the assistant's proposals, on the server: Markdown that formats is kept whole and marked, the
// mark survives the chat file, the model is told how to write it, and plain changes stay as they were.
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekdanta-assistant-format-'))
process.env.EKDANTA_VAULT = root
const { assistantPrompt, cleanTurn } = await import('./assistant.ts')
const { checkProposals } = await import('../src/lib/assistant.ts')
const { formats, plainOf, shapeOf } = await import('../src/lib/rich.ts')
const { readAsk } = await import('../src/lib/scope.ts')

test.after(() => fs.rm(root, { recursive: true, force: true }))

const TEXT = `Why I stopped chasing productivity 🚀

For three years I optimised every minute of my day.

Three things I learned:
First, less is more.
Second, mornings matter.`

test('Markdown reads as the page shows it, and only new formatting counts as formatting', () => {
  assert.equal(plainOf('## Three things\n- First\n- Second'), 'Three things\n\nFirst\n\nSecond')
  assert.equal(plainOf('A **bold** and *italic* [link](https://x.y) line\nnext'), 'A bold and italic link line\nnext')
  assert.equal(shapeOf('plain\n\ntext'), '')
  assert.ok(formats('the urgent work', '**the urgent work**'))
  assert.ok(formats('What changed', '## What changed'))
  assert.ok(!formats('a b', 'a c'))
  // The writer's own text that Markdown would misread is not taken for formatting.
  assert.ok(!formats('1990. A good year.', '1990. A great year.'))
  assert.ok(!formats('5 * 3 * 2', '5 * 3 * 2 = 30'))
})

test('the "**" pieces of a bolded phrase come back as one change of the paragraph, marked as formatting', () => {
  // As the model answered "format this document" when testing: each "**" was its own proposal before.
  const { proposals, dropped } = checkProposals(
    [
      { find: 'For three years I optimised every minute of my day.', replace: 'For three years I **optimised every minute** of my day.' },
      { find: 'Why I stopped chasing productivity 🚀', replace: '# Why I stopped chasing productivity 🚀\n\n## The problem' },
      { find: 'Three things I learned:\nFirst, less is more.\nSecond, mornings matter.', replace: '## Three things I learned\n- First, less is more.\n- Second, mornings matter.' },
    ],
    TEXT,
    { level: 5, ask: readAsk('format this document') },
  )
  assert.deepEqual(dropped, [])
  assert.deepEqual(
    proposals.map((p) => [p.find, p.replace, p.format]),
    [
      ['Why I stopped chasing productivity 🚀', '# Why I stopped chasing productivity 🚀\n\n## The problem', true],
      ['For three years I optimised every minute of my day.', 'For three years I **optimised every minute** of my day.', true],
      ['Three things I learned:\nFirst, less is more.\nSecond, mornings matter.', '## Three things I learned\n- First, less is more.\n- Second, mornings matter.', true],
    ],
  )
})

test('headings and lists need an ask for them; bold alone on a formatting ask is fine', () => {
  const heading = [{ find: 'Why I stopped chasing productivity 🚀', replace: '## Why I stopped chasing productivity 🚀' }]
  assert.equal(checkProposals(heading, TEXT, { level: 5, ask: readAsk('make the key phrases bold') }).dropped[0]?.reason, 'formatting it can’t add')
  assert.equal(checkProposals(heading, TEXT, { level: 5, ask: readAsk('add headings') }).proposals.length, 1)
  const bold = checkProposals([{ find: 'every minute', replace: '**every minute**' }], TEXT, { level: 5, ask: readAsk('make the key phrases bold') })
  assert.equal(bold.proposals[0].beyond, undefined)
  // A change that is only raw HTML never becomes a card.
  const html = checkProposals([{ find: 'Why I stopped chasing productivity 🚀', replace: 'Why I stopped chasing productivity 🚀\n\n<div>hi</div>' }], TEXT, {
    level: 5,
    ask: readAsk('format this document'),
  })
  assert.deepEqual(html.proposals, [])
  assert.equal(html.dropped[0].reason, 'formatting it can’t add')
})

test('two changes in one paragraph that format it together are one change, not an overlap', () => {
  const { proposals, dropped } = checkProposals(
    [
      { find: 'I optimised', replace: 'I **optimised' },
      { find: 'minute of my day', replace: 'minute** of my day' },
    ],
    TEXT,
    { level: 5, ask: readAsk('format this document') },
  )
  assert.deepEqual(dropped, [])
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].replace, 'For three years I **optimised every minute** of my day.')
})

test('plain changes are left as small as they were, beside a formatting one', () => {
  const { proposals } = checkProposals(
    [
      { find: 'productivity 🚀', replace: 'productivity' },
      { find: 'every minute', replace: '**every minute**' },
    ],
    TEXT,
    { level: 3, ask: readAsk('remove the emojis and make the key phrase bold') },
  )
  assert.deepEqual(
    proposals.map((p) => [p.find, p.replace, !!p.format, p.beyond]),
    [
      [' 🚀', '', false, undefined],
      ['For three years I optimised every minute of my day.', 'For three years I optimised **every minute** of my day.', true, undefined],
    ],
  )
})

test('formatting that rewrites words is still held to the help level', () => {
  const { proposals, dropped } = checkProposals([{ find: 'For three years I optimised every minute of my day.', replace: '**Every minute of every day, for three years, was optimised.**' }], TEXT, {
    level: 3,
  })
  assert.equal(proposals.length, 0)
  assert.equal(dropped[0].reason, 'over the help ceiling')
})

test('the formatting mark is kept in the chat file', () => {
  const t = cleanTurn({ id: 'a', role: 'assistant', text: 'x', at: 'y', proposals: [{ id: 'p1', start: 0, end: 3, find: 'abc', replace: '**abc**', format: true }] })
  assert.equal(t?.proposals?.[0].format, true)
  const old = cleanTurn({ id: 'a', role: 'assistant', text: 'x', at: 'y', proposals: [{ id: 'p1', start: 0, end: 3, find: 'abc', replace: 'abd', format: 'yes' }] })
  assert.equal(old?.proposals?.[0].format, undefined)
})

test('the model is told the draft has no formatting marks and how to write formatting', () => {
  const { system } = assistantPrompt({ doc: 'a.md', message: 'Make the key phrases bold', text: 'Body' }, { level: 5, history: [], notes: [], norms: 'a LinkedIn post' })
  assert.match(system, /shown as plain text/)
  assert.match(system, /\*\*bold\*\*/)
  assert.match(system, /Never escape characters with backslashes/)
  // Below level 3 nothing is written, so nothing about formatting either.
  assert.doesNotMatch(assistantPrompt({ doc: 'a.md', message: 'x', text: 'Body' }, { level: 2, history: [], notes: [], norms: 'a post' }).system, /\*\*bold\*\*/)
})
