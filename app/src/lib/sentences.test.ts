import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkForSpeech, isSpeakable, readingTimes, splitSentences, spokenText } from './sentences.ts'

const split = (t: string) => splitSentences(t).map((s) => t.slice(s.from, s.to))

test('keeps a title abbreviation inside its sentence', () => {
  assert.deepEqual(split('Dr. Rao arrived.'), ['Dr. Rao arrived.'])
  assert.deepEqual(split('Dr. Rao arrived. Mrs. Shah left early.'), ['Dr. Rao arrived.', 'Mrs. Shah left early.'])
})

test('e.g., i.e. and cf. never end a sentence', () => {
  assert.deepEqual(split('Some cities, e.g. Paris, are old. Others are not.'), ['Some cities, e.g. Paris, are old.', 'Others are not.'])
  assert.deepEqual(split('One thing, i.e. This one, matters.'), ['One thing, i.e. This one, matters.'])
  assert.deepEqual(split('See the notes (cf. Smith) for more.'), ['See the notes (cf. Smith) for more.'])
})

test('page and number abbreviations join only before a number', () => {
  assert.deepEqual(split('As shown on p. 4 the claim fails. Then it recovers.'), ['As shown on p. 4 the claim fails.', 'Then it recovers.'])
  assert.deepEqual(split('See Fig. 2 and No. 5. Done.'), ['See Fig. 2 and No. 5.', 'Done.'])
  assert.deepEqual(split('I said no. Then I left.'), ['I said no.', 'Then I left.'])
})

test('initials stay with the name', () => {
  assert.deepEqual(split('J. K. Rowling wrote it. Many read it.'), ['J. K. Rowling wrote it.', 'Many read it.'])
})

test('decimals, addresses and lower-case continuations are not ends', () => {
  assert.deepEqual(split('It cost $3.50 at example.com today. Fine.'), ['It cost $3.50 at example.com today.', 'Fine.'])
  assert.deepEqual(split('Wait... what? Yes!'), ['Wait... what?', 'Yes!'])
})

test('closing quotes and brackets belong to the sentence they end', () => {
  assert.deepEqual(split('He said, “Stop.” Then he left.'), ['He said, “Stop.”', 'Then he left.'])
  assert.deepEqual(split('(This is an aside.) Back to it.'), ['(This is an aside.)', 'Back to it.'])
  assert.deepEqual(split('She asked "why?" and "how?" Nobody knew.'), ['She asked "why?" and "how?"', 'Nobody knew.'])
})

test('a sentence without a full stop, line breaks, and surrounding spaces', () => {
  assert.deepEqual(split('  no stop at the end  '), ['no stop at the end'])
  assert.deepEqual(split('Roses are red\nViolets are blue'), ['Roses are red', 'Violets are blue'])
  assert.deepEqual(split(''), [])
  assert.deepEqual(split('   '), [])
})

test('offsets point into the original text', () => {
  const t = 'One. Two.'
  assert.deepEqual(splitSentences(t), [
    { from: 0, to: 4 },
    { from: 5, to: 9 },
  ])
})

test('citations are read as author and year', () => {
  assert.equal(spokenText('Memory is fragile (Smith, 2019, p. 4).'), 'Memory is fragile Smith 2019.')
  assert.equal(spokenText('As argued (Smith & Jones, 2020; Rao et al., 2018).'), 'As argued Smith & Jones 2020, Rao et al. 2018.')
  assert.equal(spokenText('An aside (which matters) stays.'), 'An aside (which matters) stays.')
  assert.equal(spokenText('Undated (Lee, n.d.).'), 'Undated Lee no date.')
})

test('footnote markers are not read', () => {
  assert.equal(spokenText('A claim.[^1] Another[^note-2] one.'), 'A claim. Another one.')
  assert.equal(spokenText('A claim.¹'), 'A claim.')
  assert.equal(isSpeakable('[^1]'), false)
  assert.equal(isSpeakable('* * *'), false)
  assert.equal(isSpeakable('Yes.'), true)
})

test('long sentences are spoken in pieces, at commas where possible', () => {
  const long = Array.from({ length: 30 }, (_, i) => `clause number ${i}`).join(', ') + '.'
  const parts = chunkForSpeech(long, 120)
  assert.ok(parts.length > 1)
  assert.ok(parts.every((p) => p.length <= 120))
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long)
  assert.deepEqual(chunkForSpeech('Short.'), ['Short.'])
  assert.ok(chunkForSpeech('x'.repeat(500), 200).every((p) => p.length <= 200))
})

test('minutes to read and to say', () => {
  assert.equal(readingTimes(0), '')
  assert.equal(readingTimes(130), 'under a minute to read · about 1 min to say')
  assert.equal(readingTimes(40), 'under a minute to read · under a minute to say')
  assert.equal(readingTimes(1428), 'about 6 min to read · 10 min to say')
  assert.equal(readingTimes(1200), 'about 5 min to read · 8 min to say')
})
