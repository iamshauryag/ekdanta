import test from 'node:test'
import assert from 'node:assert/strict'
import { SERVER_DOWN, friendlyError, helpLevel, planCaret, type Caret, type Level } from './caret.ts'
import { isCompleteWord } from '../lib/prose.ts'

const base: Caret = { block: 'paragraph', text: 'I walk every morning.', atEnd: true, partial: '', suffix: '', lineStart: false, hasPrevious: true, hasOwn: true, title: 'Why I walk' }
const plan = (level: Level, c: Partial<Caret> = {}) => planCaret(level, { ...base, ...c }, isCompleteWord)

test('help keys: ⌥ or ⌘ with a digit, not both, not with shift or control', () => {
  const k = (code: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>>) => ({ code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods })
  assert.equal(helpLevel(k('Digit3', { altKey: true })), 3)
  assert.equal(helpLevel(k('Digit5', { metaKey: true })), 5)
  assert.equal(helpLevel(k('Digit6', { altKey: true })), null)
  assert.equal(helpLevel(k('Digit1', { altKey: true, metaKey: true })), null)
  assert.equal(helpLevel(k('Digit1', { metaKey: true, shiftKey: true })), null)
  assert.equal(helpLevel(k('Digit1', {})), null)
})

test('code blocks and tables: help is off', () => {
  for (const level of [1, 2, 3, 4, 5] as Level[]) {
    assert.deepEqual(plan(level, { block: 'code' }), { do: 'notice', text: 'code' })
    assert.deepEqual(plan(level, { block: 'table' }), { do: 'notice', text: 'table' })
  }
})

test('end of a paragraph: next word, next sentence, continue the paragraph', () => {
  assert.deepEqual(plan(1), { do: 'recall', on: 'block' })
  assert.deepEqual(plan(2), { do: 'nudge', on: 'block' })
  assert.deepEqual(plan(3), { do: 'word', mode: 'next' })
  assert.deepEqual(plan(4), { do: 'ghost', place: 'inline', list: false })
  assert.deepEqual(plan(5), { do: 'continue', place: 'inline', list: false })
})

test('mid-paragraph ⌘5 keeps the rewrite bar, with a hint', () => {
  assert.deepEqual(plan(5, { atEnd: false }), { do: 'bar', hint: true })
  assert.deepEqual(plan(4, { atEnd: false }), { do: 'ghost', place: 'inline', list: false })
})

test('in or after a word: ⌘3 finishes it, unless it is a short complete word', () => {
  assert.deepEqual(plan(3, { partial: 'writ' }), { do: 'word', mode: 'complete' })
  assert.deepEqual(plan(3, { partial: 'wri', suffix: 'ting', atEnd: false }), { do: 'word', mode: 'complete' })
  assert.deepEqual(plan(3, { partial: 'the' }), { do: 'word', mode: 'next' })
  assert.deepEqual(plan(3, { partial: 'the', suffix: 're', atEnd: false }), { do: 'word', mode: 'complete' })
  // ⌘4 inside a word puts its sentence after the whole word ("writ|ing" never becomes "writ… ing").
  assert.deepEqual(plan(4, { partial: 'wri', suffix: 'ting', atEnd: false }), { do: 'ghost', place: 'wordEnd', list: false })
  assert.deepEqual(plan(4, { partial: 'writing' }), { do: 'ghost', place: 'inline', list: false })
  // ⌘5 inside a word is never a continuation.
  assert.deepEqual(plan(5, { partial: 'wri', suffix: 'ting', atEnd: false }), { do: 'bar', hint: true })
})

test('straight after a line break: a new line, capitalised', () => {
  const b = { lineStart: true }
  assert.deepEqual(plan(3, b), { do: 'word', mode: 'opener' })
  assert.deepEqual(plan(4, b), { do: 'ghost', place: 'paragraphStart', list: false })
  assert.deepEqual(plan(5, b), { do: 'continue', place: 'paragraphStart', list: false })
  assert.deepEqual(plan(5, { ...b, atEnd: false }), { do: 'bar', hint: true })
  assert.deepEqual(plan(1, b), { do: 'recall', on: 'block' })
})

test('an empty line after the writer’s text', () => {
  const e = { text: '', atEnd: true }
  assert.deepEqual(plan(1, e), { do: 'recall', on: 'previous' })
  assert.deepEqual(plan(2, e), { do: 'nudge', on: 'next' })
  assert.deepEqual(plan(3, e), { do: 'word', mode: 'opener' })
  assert.deepEqual(plan(4, e), { do: 'ghost', place: 'paragraphStart', list: false })
  assert.deepEqual(plan(5, e), { do: 'continue', place: 'paragraphStart', list: false })
  assert.deepEqual(plan(1, { ...e, hasPrevious: false }), { do: 'recall', on: 'title' })
  assert.deepEqual(plan(1, { ...e, hasPrevious: false, title: '' }), { do: 'notice', text: 'firstLine' })
})

test('an empty body with a title: questions, never prose', () => {
  const e = { text: '', hasOwn: false, hasPrevious: false }
  assert.deepEqual(plan(1, e), { do: 'recall', on: 'title' })
  assert.deepEqual(plan(2, e), { do: 'nudge', on: 'opening' })
  for (const level of [3, 4, 5] as Level[]) assert.deepEqual(plan(level, e), { do: 'questions' })
  // A few words that aren't yet a sentence: still questions for 3–5, Recall and Nudge on the words.
  const f = { text: 'writ', partial: 'writ', hasOwn: false }
  assert.deepEqual(plan(1, f), { do: 'recall', on: 'block' })
  assert.deepEqual(plan(2, f), { do: 'nudge', on: 'block' })
  for (const level of [3, 4, 5] as Level[]) assert.deepEqual(plan(level, f), { do: 'questions' })
})

test('an empty body and no title: write a line first', () => {
  const e = { text: '', hasOwn: false, hasPrevious: false, title: '' }
  for (const level of [1, 2, 3, 4, 5] as Level[]) assert.deepEqual(plan(level, e), { do: 'notice', text: 'firstLine' })
  // Words but no title: questions about the words.
  assert.deepEqual(plan(5, { text: 'walking', hasOwn: false, title: '' }), { do: 'questions' })
})

test('a heading: ⌘4 and ⌘5 write the section beneath it', () => {
  const h = { block: 'heading' as const, text: 'Mornings' }
  assert.deepEqual(plan(4, h), { do: 'ghost', place: 'afterHeading', list: false })
  assert.deepEqual(plan(5, h), { do: 'continue', place: 'afterHeading', list: false })
  assert.deepEqual(plan(5, { ...h, atEnd: false }), { do: 'continue', place: 'afterHeading', list: false })
  assert.deepEqual(plan(3, h), { do: 'word', mode: 'next' })
  assert.deepEqual(plan(5, { ...h, text: '' }), { do: 'continue', place: 'afterHeading', list: false })
})

test('a list item: ⌘4 and ⌘5 propose the next item', () => {
  const l = { block: 'listItem' as const, text: 'Shoes that fit' }
  assert.deepEqual(plan(4, l), { do: 'ghost', place: 'nextItem', list: true })
  assert.deepEqual(plan(5, l), { do: 'continue', place: 'nextItem', list: true })
  assert.deepEqual(plan(4, { ...l, text: '' }), { do: 'ghost', place: 'paragraphStart', list: true })
  assert.deepEqual(plan(5, { ...l, text: '' }), { do: 'continue', place: 'paragraphStart', list: true })
})

test('errors name the provider actually in use', () => {
  assert.equal(friendlyError(SERVER_DOWN, 'claude-cli'), 'Ekdanta’s server isn’t running · start it with `npm run dev`')
  assert.match(friendlyError('Claude CLI session ended', 'claude-cli'), /^Couldn’t reach Claude CLI/)
  assert.match(friendlyError('spawn claude ENOENT', 'claude-cli'), /^Couldn’t reach Claude CLI/)
  assert.match(friendlyError('fetch failed', 'ollama'), /^Couldn’t reach Ollama/)
  assert.match(friendlyError('Ollama returned 500', null), /^Couldn’t reach Ollama/)
  assert.match(friendlyError('Claude CLI timed out', 'claude-cli'), /^Claude CLI took too long/)
  assert.match(friendlyError('fetch failed', 'anthropic-api'), /^Couldn’t reach the Anthropic API/)
  assert.equal(friendlyError('Your API key was rejected', 'anthropic-api'), 'Your API key was rejected')
  assert.match(friendlyError('No JSON in reply', 'claude-cli'), /^Claude CLI gave an answer that couldn’t be read/)
  assert.match(friendlyError('No model available. Start Ollama, or sign in to the Claude CLI.', null), /^No model available/)
  // A signed-in CLI that fails for another reason isn't told to install or sign in.
  assert.match(friendlyError('Invalid API key · Please run /login', 'claude-cli'), /installed and signed in/)
  assert.equal(friendlyError('API Error: 500 Internal server error', 'claude-cli'), 'Claude CLI couldn’t answer · API Error: 500 Internal server error')
  assert.match(friendlyError('Claude AI usage limit reached', 'claude-cli'), /^Claude CLI is busy or at its limit/)
  assert.match(friendlyError('Ollama returned 429: rate limit', 'ollama'), /^Ollama is busy or at its limit/)
})
