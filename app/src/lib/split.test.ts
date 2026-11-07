// Every lookbehind the client used to have, run beside its replacement. Node can still run the old
// patterns, so each pair is compared directly over tricky inputs and a seeded fuzz of the characters
// that matter. If a replacement ever drifts from the old behaviour, this says where.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AFTER_STOP, splitAfter } from './split.ts'
import { sentenceCount } from './versions.ts'
import { cleanLine, sentencesOf } from './edge.ts'
import { isReaderQuestion } from './reader.ts'
import { spokenText } from './sentences.ts'

const CORPUS = [
  '',
  ' ',
  '.',
  '. ',
  ' .',
  '..',
  '...',
  'Hi...',
  'Hi... there',
  'Hi…',
  'Hi… there.',
  'One. Two.',
  'One.  Two.   ',
  'One.\tTwo.\nThree',
  'One.\n\nTwo',
  'Wait!? What?! No.',
  'Dr. Smith met Mr. Jones. They talked.',
  'e.g. this and i.e. that. Then more.',
  'J. R. R. Tolkien wrote it. Fine.',
  'He said "stop." Then left.',
  "He said 'stop.' Then left.",
  'He said “stop.” Then left.',
  'He said ‘stop.’ Then left.',
  '(An aside.) Back again.',
  '[A bracket.] Back again.',
  'Nested (“quote.”) closes. Next.',
  'She asked "why?" and left.',
  'A."."  B',
  'a. . b',
  'Trailing space. ',
  'Trailing spaces.   ',
  '  Leading. Spaces.',
  'No stop at all',
  'Version 1.2 is out. Get it.',
  '3.14 is pi. Yes.',
  'Ends with closers.)" ',
  'Ends with closers.)"',
  'Stop.)\u00a0Next',
  'Stop.\u2003Next',
  '你好。再见。 Done. OK',
  'لماذا؟ هذا. نعم',
  'Τι\u037e Ναι. Όχι',
  'What？ Really？ Yes.',
  'A note.¹ Next.',
  'A note¹. Next.',
  'Word¹²³ and word,⁴ and (aside)⁵ and “quote”⁶ and ‘q’⁷ and "q"⁸ and \'q\'⁹ and end.¹⁰',
  '¹ leading superscript',
  ' ¹ after a space',
  '2¹ after a digit',
  'x¹.² mixed',
  'a¹²³⁴⁵⁶⁷⁸⁹⁰ all digits',
  'Ünïcödé¹ letters',
  '日本¹ CJK letter',
  'Is this it? I lost the thread here. Who is she? Why?',
  'Why? Because. Really? Yes!',
]

// A seeded fuzz over the characters the patterns care about.
function* fuzz(n: number) {
  const alphabet = ['a', 'B', '.', '.', '!', '?', '…', '"', "'", '”', '’', ')', ']', '(', ' ', ' ', '\t', '\n', '¹', '²', '⁰', ',', ';', ':', '？', '؟', '\u037e', 'é', '1']
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff)
  for (let i = 0; i < n; i++) {
    const len = Math.floor(rand() * 14)
    let s = ''
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)]
    yield s
  }
}
const INPUTS = [...CORPUS, ...fuzz(20000)]

function same<T>(name: string, oldFn: (s: string) => T, newFn: (s: string) => T) {
  for (const s of INPUTS) assert.deepEqual(newFn(s), oldFn(s), `${name} differs on ${JSON.stringify(s)}`)
}

test('splitAfter matches a lookbehind split', () => {
  same(
    'plain',
    (s) => s.split(/(?<=[.!?])\s+/),
    (s) => splitAfter(s, AFTER_STOP),
  )
  assert.deepEqual(splitAfter('One. Two!  Three', AFTER_STOP), ['One.', 'Two!', 'Three'])
  assert.deepEqual(splitAfter('End. ', AFTER_STOP), ['End.', ''])
  assert.deepEqual(splitAfter('', AFTER_STOP), [''])
  assert.throws(() => splitAfter('a. b', /([.])\s+/))
})

test('controller: is more than one sentence selected', () => {
  same(
    'controller',
    (s) =>
      s
        .trim()
        .split(/(?<=[.!?])\s+/)
        .filter(Boolean),
    (s) => splitAfter(s.trim(), AFTER_STOP).filter(Boolean),
  )
})

test('versions: sentenceCount', () => {
  const old = (text: string) =>
    text
      .trim()
      .split(/(?<=[.!?…])["'”’)]*\s+/)
      .filter((s) => /[\p{L}\p{N}]/u.test(s)).length
  same('sentenceCount', old, sentenceCount)
  assert.equal(sentenceCount('He said "stop." Then left.'), 2)
  assert.equal(sentenceCount('Hi... there'), 2)
  assert.equal(sentenceCount('.'), 0)
  assert.equal(sentenceCount('One fragment'), 1)
})

test('reader: two sentences at most in a question', () => {
  same(
    'reader split',
    (s) => s.split(/(?<=[.!?？؟\u037e])\s+/).filter(Boolean),
    (s) => splitAfter(s, /([.!?？؟\u037e])\s+/g).filter(Boolean),
  )
  assert.equal(isReaderQuestion('I lost the thread here. Who is she?'), true)
  assert.equal(isReaderQuestion('One. Two. Who is she?'), false)
  assert.equal(isReaderQuestion('لماذا؟ هذا. نعم؟'), false)
  assert.equal(isReaderQuestion('What？ Really？'), true)
  assert.equal(isReaderQuestion('Τι\u037e Ναι\u037e'), true)
  assert.equal(isReaderQuestion('Τι\u037e Ναι\u037e Όχι\u037e'), false)
})

test('edge: sentencesOf splits as before, closers kept with their sentence', () => {
  same(
    'edge split',
    (s) => s.split(/(?<=[.!?…]["'”’)\]]*)\s+(?=\S)/),
    (s) => splitAfter(s, /([.!?…]["'”’)\]]*)\s+(?=\S)/g),
  )
  assert.deepEqual(sentencesOf('He said “stop now.” Then he left the room.'), ['He said “stop now.”', 'Then he left the room.'])
  assert.deepEqual(sentencesOf('Dr. Smith came in. She sat down.'), ['Dr. Smith came in.', 'She sat down.'])
  // An ellipsis ends a sentence here, as it always has.
  assert.deepEqual(sentencesOf('We waited… and waited. Nothing came.'), ['We waited…', 'and waited.', 'Nothing came.'])
})

test('edge: cleanLine drops one full stop from a title, never an ellipsis', () => {
  const old = (t: string) => t.replace(/(?<!\.)\.$/, '')
  for (const s of [...INPUTS, 'Title.', 'Title..', 'Title...', 'Title…', '.', '..', 'A. B.', 'Hi...']) {
    const want = cleanLine(s, 'excerpt')
    assert.equal(cleanLine(s, 'title'), old(want), `title differs on ${JSON.stringify(s)}`)
    assert.equal(cleanLine(s, 'subject'), old(want), `subject differs on ${JSON.stringify(s)}`)
  }
  assert.equal(cleanLine('A good title.', 'title'), 'A good title')
  assert.equal(cleanLine('Wait for it...', 'title'), 'Wait for it...')
  assert.equal(cleanLine('.', 'subject'), '')
  assert.equal(cleanLine('Keep the stop.', 'opening'), 'Keep the stop.')
})

test('sentences: spokenText drops superscript note numbers as before', () => {
  same(
    'superscripts',
    (s) => s.replace(/(?<=[\p{L}.,;:!?)”’"'])[¹²³⁴⁵⁶⁷⁸⁹⁰]+/gu, ''),
    (s) => s.replace(/([\p{L}.,;:!?)”’"'])[¹²³⁴⁵⁶⁷⁸⁹⁰]+/gu, '$1'),
  )
  assert.equal(spokenText('A claim.¹ Another¹² one.'), 'A claim. Another one.')
  assert.equal(spokenText('Two¹ squared is 2² here.'), 'Two squared is 2² here.')
})
