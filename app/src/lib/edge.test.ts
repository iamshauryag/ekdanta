import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EDGE_LIMITS,
  asWritten,
  cleanLine,
  fieldSlot,
  fromLine,
  guardCandidates,
  inDraft,
  inWritersQuotes,
  inventedNames,
  inventedNumbers,
  openingEdit,
  sentencesOf,
  showSuggestLink,
  titleHelp,
  titleSlot,
} from './edge.ts'

const DRAFT = `We shipped the new onboarding last Tuesday. Signups went up 40% in a week. Maria from support caught the bug that had blocked half of them.

The fix took one line. I keep thinking about how long we lived with it.`

test('sentencesOf splits whole sentences and ignores one-word fragments', () => {
  assert.equal(sentencesOf(DRAFT).length, 5)
  assert.deepEqual(sentencesOf('Hi. Thanks for the note. See you soon!'), ['Thanks for the note.', 'See you soon!'])
  assert.deepEqual(sentencesOf('  '), [])
  assert.equal(sentencesOf('“It works,” she said. Then it broke.').length, 2)
})

test('the title matrix: only ⌘3 with a 3+ sentence draft and ceiling ≥ 3 changes', () => {
  for (const level of [1, 2, 3, 4, 5]) {
    for (const sentences of [0, 1, 2, 3, 8]) {
      for (const ceiling of [0, 2, 3, 5]) {
        const got = titleHelp(level, sentences, ceiling, 'essay')
        const edge = level === 3 && sentences >= 3 && ceiling >= 3
        assert.deepEqual(got, edge ? { mode: 'edge', slot: 'title' } : { mode: 'body' }, `level ${level}, ${sentences} sentences, ceiling ${ceiling}`)
      }
    }
  }
})

test('LinkedIn and text messages get an opening line instead of a title', () => {
  assert.equal(titleSlot('linkedin'), 'opening')
  assert.equal(titleSlot('LinkedIn'), 'opening')
  assert.equal(titleSlot('text'), 'opening')
  assert.equal(titleSlot('essay'), 'title')
  assert.equal(titleSlot('email'), 'title')
  assert.deepEqual(titleHelp(3, 5, 5, 'linkedin'), { mode: 'edge', slot: 'opening' })
  assert.deepEqual(titleHelp(3, 2, 5, 'linkedin'), { mode: 'body' })
})

test('Subject for email, Excerpt for blog, nothing for other kinds; hidden below ceiling 3', () => {
  assert.deepEqual(fieldSlot('email'), { slot: 'subject', key: 'subject' })
  assert.deepEqual(fieldSlot('blog'), { slot: 'excerpt', key: 'excerpt' })
  assert.equal(fieldSlot('essay'), null)
  assert.equal(fieldSlot('linkedin'), null)
  assert.equal(showSuggestLink(2), false)
  assert.equal(showSuggestLink(3), true)
  assert.equal(showSuggestLink(0), false)
})

test('a source must be an exact substring of the draft (spacing and curly quotes aside)', () => {
  assert.ok(inDraft('Signups went up 40% in a week.', DRAFT))
  assert.ok(inDraft('The fix took   one line.', DRAFT))
  assert.ok(!inDraft('Signups went up 45% in a week.', DRAFT))
  assert.ok(!inDraft('', DRAFT))
  assert.ok(inDraft('“It works,” she said.', '"It works," she said. Then.'))
})

test('numbers must appear in the draft as written', () => {
  assert.deepEqual(inventedNumbers('We raised $5M', DRAFT), ['$5M'])
  assert.deepEqual(inventedNumbers('Signups up 40%', DRAFT), [])
  assert.deepEqual(inventedNumbers('Signups up 40 percent', DRAFT), ['40 percent'])
  assert.deepEqual(inventedNumbers('One line, 2 days', DRAFT), ['2'])
  assert.deepEqual(inventedNumbers('$5M', 'Revenue hit $5M this year.'), [])
  assert.deepEqual(inventedNumbers('$5M', 'We have 5 people.'), ['$5M'])
  assert.deepEqual(inventedNumbers('1,200 readers', 'We had 1200 readers.'), [])
})

test('capitalised names must appear in the draft; grammar capitals and Title Case are fine', () => {
  assert.deepEqual(inventedNames('Maria Caught the Bug', DRAFT), [])
  assert.deepEqual(inventedNames('How Maria and Stripe fixed onboarding', DRAFT), ['Stripe'])
  assert.deepEqual(inventedNames('Why One Line Mattered', DRAFT), ['Mattered'])
  assert.deepEqual(inventedNames('The fix took one line', DRAFT), [])
  assert.deepEqual(inventedNames("Maria's fix", DRAFT), [])
})

test('cleanLine drops labels, quotes and a title’s full stop', () => {
  assert.equal(cleanLine('Subject: "The one-line fix."', 'subject'), 'The one-line fix')
  assert.equal(cleanLine('“The fix took one line.”', 'opening'), 'The fix took one line.')
  assert.equal(cleanLine('Why it took so long?', 'title'), 'Why it took so long?')
  assert.equal(cleanLine('  The  fix \n took one line ', 'title'), 'The fix took one line')
})

test('guardCandidates drops invented numbers and names, bad sources, long lines, repeats', () => {
  const raw = [
    { text: 'Signups went up 40% in a week', source: 'Signups went up 40% in a week.' },
    { text: 'We raised $5M', source: 'We shipped the new onboarding last Tuesday.' },
    { text: 'Stripe caught the bug', source: 'Maria from support caught the bug that had blocked half of them.' },
    { text: 'The fix took one line', source: 'This sentence is not in the draft.' },
    { text: 'x'.repeat(EDGE_LIMITS.subject + 1), source: 'The fix took one line.' },
    { text: 'signups went up 40% in a week', source: 'Signups went up 40% in a week.' },
    { text: 'The fix took one line', source: 'The fix took one line.' },
    { text: 42, source: 'The fix took one line.' },
    null,
    { text: '...', source: 'The fix took one line.' },
  ]
  const got = guardCandidates(raw, DRAFT, 'subject')
  assert.deepEqual(
    got.map((c) => c.text),
    ['Signups went up 40% in a week', 'The fix took one line'],
  )
  assert.equal(got[1].source, 'The fix took one line.')
})

test('guardCandidates honours the per-slot limits', () => {
  const long = 'Maria from support caught the bug that had blocked half of them'
  assert.equal(long.length, 63)
  const c = [{ text: long, source: 'Maria from support caught the bug that had blocked half of them.' }]
  assert.equal(guardCandidates(c, DRAFT, 'subject').length, 1)
  const over = [{ text: long + ' '.repeat(1) + 'and more', source: c[0].source }]
  assert.equal(guardCandidates(over, DRAFT, 'subject').length, 0)
  assert.equal(guardCandidates(over, DRAFT, 'title').length, 1) // 71 characters fits a title (90) but not a subject (70)
  assert.equal(guardCandidates([{ text: 'a '.repeat(106).trim(), source: c[0].source }], DRAFT, 'opening').length, 0)
})

test('guardCandidates excludes lines already shown and the current value, and keeps at most five', () => {
  const lines = sentencesOf(DRAFT).map((s) => ({ text: s.replace(/\.$/, ''), source: s }))
  assert.equal(guardCandidates(lines, DRAFT, 'opening').length, 5)
  const avoid = ['We shipped the new onboarding last Tuesday']
  const got = guardCandidates(lines, DRAFT, 'title', { avoid, current: 'The fix took one line' })
  assert.ok(!got.some((c) => c.text === avoid[0]))
  assert.ok(!got.some((c) => c.text === 'The fix took one line'))
  assert.equal(guardCandidates('not a list', DRAFT, 'title').length, 0)
  // The current opening, with or without its full stop, isn't offered back.
  assert.equal(guardCandidates([{ text: 'The fix took one line', source: 'The fix took one line.' }], DRAFT, 'opening', { current: 'The fix took one line.' }).length, 0)
})

test('openingEdit replaces the first sentence it came from, otherwise adds a paragraph in front', () => {
  const para = 'We shipped the new onboarding last Tuesday. Signups went up 40% in a week.'
  assert.equal(openingEdit(para, 'We shipped onboarding on Tuesday.', 'We shipped the new onboarding last Tuesday.'), 'We shipped onboarding on Tuesday. Signups went up 40% in a week.')
  assert.equal(openingEdit(para, 'The fix took one line.', 'The fix took one line.'), `The fix took one line.\n\n${para}`)
  assert.equal(openingEdit('', 'The fix took one line.', 'x'), 'The fix took one line.')
  assert.equal(openingEdit(para, 'We shipped onboarding on Tuesday', 'We shipped the new onboarding last Tuesday.'), 'We shipped onboarding on Tuesday. Signups went up 40% in a week.')
  assert.equal(openingEdit('Is it done? Yes.', 'Is it done', 'Is it done?'), 'Is it done? Yes.')
})

test('fromLine shortens long sources on a word boundary', () => {
  assert.equal(fromLine('Short one.'), 'Short one.')
  const s = fromLine('word '.repeat(40), 30)
  assert.ok(s.length <= 30 && s.endsWith('…'))
})

test('curly apostrophes in the draft don’t make a contraction look like an invented name', () => {
  const draft = 'I’ve kept a notebook for years. Don’t throw out the bad pages. We’re all slower than we think. It’s fine to start small.'
  assert.deepEqual(inventedNames("Don't throw out the bad pages", draft), [])
  assert.deepEqual(inventedNames('We’re all slower', "We're all slower than we think."), [])
  const raw = sentencesOf(draft.replace(/’/g, "'")).map((s) => ({ text: s.replace(/\.$/, ''), source: s }))
  const got = guardCandidates(raw, draft, 'opening')
  assert.equal(got.length, 4)
  // The writer's own apostrophes come back, in the line and in its source.
  assert.equal(got[1].text, 'Don’t throw out the bad pages')
  assert.equal(got[1].source, 'Don’t throw out the bad pages.')
  assert.equal(asWritten('"It works," she said.', 'He waved. “It works,”  she said. Then.'), '“It works,”  she said.')
  assert.equal(inWritersQuotes("Don't stop", 'plain straight draft'), "Don't stop")
})

test('greetings, sign-offs and abbreviations don’t make sentences', () => {
  const email = 'Hi Priya,\n\nWe met Dr. Smith on Monday. She liked the plan.\n\nThanks,\nSam'
  assert.deepEqual(sentencesOf(email), ['We met Dr. Smith on Monday.', 'She liked the plan.'])
  assert.deepEqual(sentencesOf('Ask e.g. a friend first. Then wait.'), ['Ask e.g. a friend first.', 'Then wait.'])
  // A line of four words or fewer ending in a comma is a greeting; a longer one is still prose.
  assert.equal(sentencesOf('When I started this job, I thought I knew everything,').length, 1)
})
