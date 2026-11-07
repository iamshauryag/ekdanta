import test from 'node:test'
import assert from 'node:assert/strict'
import {
  capitalizeFirst,
  firstWord,
  hasOwnSentence,
  isCompleteWord,
  joinOnto,
  listItem,
  plainProse,
  repeatsFollowing,
  sentences,
  splitFirstSentence,
  wholeSentences,
  wordAtCaret,
  wordEnding,
} from './prose.ts'

test('the word at the caret: letters before and after it', () => {
  assert.deepEqual(wordAtCaret('I like writ', ''), { partial: 'writ', suffix: '' })
  assert.deepEqual(wordAtCaret('I like wri', 'ting well'), { partial: 'wri', suffix: 'ting' })
  assert.deepEqual(wordAtCaret('I like ', 'writing'), { partial: '', suffix: '' })
  assert.deepEqual(wordAtCaret('It ended.', ''), { partial: '', suffix: '' })
  assert.deepEqual(wordAtCaret('I don’t', ''), { partial: 'don’t', suffix: '' })
  assert.deepEqual(wordAtCaret('She said ‘hel', ''), { partial: 'hel', suffix: '' })
  assert.deepEqual(wordAtCaret('', ''), { partial: '', suffix: '' })
  assert.deepEqual(wordAtCaret('line\n', 'next'), { partial: '', suffix: '' })
  assert.deepEqual(wordAtCaret('café', ''), { partial: 'café', suffix: '' })
})

test('short function words count as complete', () => {
  assert.equal(isCompleteWord('the'), true)
  assert.equal(isCompleteWord('The'), true)
  assert.equal(isCompleteWord('writ'), false)
  assert.equal(isCompleteWord('there'), false)
})

test('one sentence of the writer’s own text', () => {
  assert.equal(hasOwnSentence(''), false)
  assert.equal(hasOwnSentence('writ'), false)
  assert.equal(hasOwnSentence('Why I walk'), false)
  assert.equal(hasOwnSentence('I walk.'), true)
  assert.equal(hasOwnSentence('I walk every morning'), true)
  assert.equal(hasOwnSentence('   \n\n  '), false)
})

test('model prose loses list markers, headings and line breaks', () => {
  assert.equal(plainProse('## A heading\n- First thing.\n- Second thing.'), 'A heading First thing. Second thing.')
  assert.equal(plainProse('1. One.\n2) Two.'), 'One. Two.')
  assert.equal(plainProse('> Quoted line.\n\n**Bold line**'), 'Quoted line. Bold line')
  assert.equal(plainProse('- [ ] a task'), 'a task')
  assert.equal(plainProse('Plain text stays.'), 'Plain text stays.')
})

test('sentences keep their punctuation and closing quotes', () => {
  assert.deepEqual(sentences('One. Two! Three?'), ['One.', 'Two!', 'Three?'])
  assert.deepEqual(sentences('He said “go.” Then left.'), ['He said “go.”', 'Then left.'])
  assert.deepEqual(sentences('Done. Unfinished'), ['Done.', 'Unfinished'])
  assert.deepEqual(sentences('3.5 miles. Then home.'), ['3.5 miles.', 'Then home.'])
})

test('whole sentences within a budget', () => {
  const t = 'One two three. Four five six. Seven eight nine. Ten eleven twelve. Thirteen fourteen.'
  assert.equal(wholeSentences(t, 90), 'One two three. Four five six. Seven eight nine. Ten eleven twelve.')
  assert.equal(wholeSentences(t, 7), 'One two three. Four five six.')
  assert.equal(wholeSentences(t, 90, 2), 'One two three. Four five six.')
  assert.equal(wholeSentences('A full one. And then a half', 90), 'A full one.')
  assert.equal(wholeSentences('no ending at all', 90), '')
  // A first sentence a little over a tiny budget is kept; a runaway one is not.
  assert.equal(wholeSentences('One two three four five.', 3), 'One two three four five.')
  assert.equal(wholeSentences('One two three four five six seven.', 3), '')
})

test('a ghost splits into its first sentence and the rest', () => {
  assert.deepEqual(splitFirstSentence(' It rained. Then it stopped.'), [' It rained.', ' Then it stopped.'])
  assert.deepEqual(splitFirstSentence('Only one.'), ['Only one.', ''])
  assert.deepEqual(splitFirstSentence(' no end'), [' no end', ''])
  assert.deepEqual(splitFirstSentence(' “Go.” She went.'), [' “Go.”', ' She went.'])
  assert.deepEqual(splitFirstSentence(' It ran 3.5 miles. Then home.'), [' It ran 3.5 miles.', ' Then home.'])
  assert.equal(firstWord(' Then it stopped.'), ' Then')
})

test('joining a continuation onto the writer’s text', () => {
  assert.equal(joinOnto('I walked', 'home.', false), ' home.')
  assert.equal(joinOnto('I walked ', 'home.', false), 'home.')
  assert.equal(joinOnto('I walked', ', slowly.', false), ', slowly.')
  assert.equal(joinOnto('Line\n', 'next.', false), 'next.')
  assert.equal(joinOnto('Earlier text.', ' the next paragraph.', true), 'The next paragraph.')
  assert.equal(joinOnto('Earlier text.', '“quoted” start.', true), '“Quoted” start.')
  assert.equal(joinOnto('', 'start.', false), 'start.')
  assert.equal(capitalizeFirst('élan.'), 'Élan.')
})

test('letters that finish a word are letters only', () => {
  assert.deepEqual(wordEnding('ing'), ['ing', ''])
  assert.deepEqual(wordEnding(' ing '), ['ing', ''])
  assert.deepEqual(wordEnding('d.'), ['d', '.'])
  assert.deepEqual(wordEnding(''), ['', ''])
  assert.deepEqual(wordEnding('ing, and'), ['', ''])
})

test('a suggestion that repeats what follows is an echo', () => {
  assert.equal(repeatsFollowing('The rain stopped.', 'The rain stopped. Then we left.'), true)
  assert.equal(repeatsFollowing('It was late and the rain had stopped.', 'Outside, it was late and the rain had stopped. We left.'), true)
  assert.equal(repeatsFollowing('Yes.', 'We said yes to it.'), false)
  assert.equal(repeatsFollowing('Something new.', ''), false)
})

test('a list item is never cut mid-thought', () => {
  assert.equal(listItem('Buy milk and bread'), 'Buy milk and bread')
  const long = 'Walk early. Take the long way past the river, ' + 'and keep going '.repeat(15) + 'until the path turns back.'
  assert.equal(listItem(long, 40), 'Walk early.')
  const fragment = 'Pack light, with a bag that fits under the seat; ' + 'nothing that needs checking and nothing you would miss if it were lost somewhere along the way '.repeat(2)
  assert.equal(listItem(fragment, 20), 'Pack light, with a bag that fits under the seat')
  assert.equal(listItem('word '.repeat(50), 40), '')
})
