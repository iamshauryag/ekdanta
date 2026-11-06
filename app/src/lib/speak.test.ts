import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Reader, isOnlineVoice, pickVoice, sortVoices, voiceLabel, type ReaderState, type Sentence, type SynthLike, type UtteranceLike, type VoiceLike } from './speak.ts'

/** A speechSynthesis that speaks nothing: the test says when each utterance ends. */
class FakeSynth implements SynthLike {
  queue: UtteranceLike[] = []
  spoken: string[] = []
  cancels = 0
  speak(u: UtteranceLike) {
    this.queue.push(u)
    this.spoken.push(u.text)
  }
  cancel() {
    this.cancels++
    // Chrome reports a cancelled utterance as an error ("interrupted"), late.
    const dropped = this.queue
    this.queue = []
    for (const u of dropped) u.onerror?.({ error: 'interrupted' })
  }
  getVoices() {
    return []
  }
  /** The utterance being said finishes. */
  finish() {
    const u = this.queue.shift()
    u?.onend?.()
  }
}

const utter = (text: string): UtteranceLike => ({ text, lang: '', rate: 1, voice: null, onend: null, onerror: null })

function setup() {
  const synth = new FakeSynth()
  const states: { state: ReaderState; sentence: Sentence | null }[] = []
  const reader = new Reader(synth, utter, (state, sentence) => states.push({ state, sentence }))
  const last = () => states[states.length - 1]
  return { synth, reader, states, last }
}

test('cancelled by something else on the page (a sample in Settings): paused, not stuck playing', () => {
  const { synth, reader, last } = setup()
  reader.start(sentences, 1)
  synth.cancel()
  assert.deepEqual(last().state, { status: 'paused', index: 1, total: 3 })
  reader.toggle()
  assert.equal(last().state.status, 'playing')
  assert.deepEqual(synth.spoken, ['She sat down.', 'She sat down.'])
})

const sentences: Sentence[] = [
  { text: 'Dr. Rao arrived.', from: 1, to: 17 },
  { text: 'She sat down.', from: 18, to: 31 },
  { text: 'It was late (Smith, 2019, p. 4).', from: 33, to: 65 },
]

test('reads one sentence at a time, highlighting each, and stops at the end', () => {
  const { synth, reader, last } = setup()
  reader.start(sentences, 0)
  assert.deepEqual(last().state, { status: 'playing', index: 0, total: 3 })
  assert.equal(last().sentence?.from, 1)
  assert.deepEqual(synth.spoken, ['Dr. Rao arrived.'])
  synth.finish()
  assert.equal(last().state.index, 1)
  assert.deepEqual(synth.spoken, ['Dr. Rao arrived.', 'She sat down.'])
  synth.finish()
  // The citation is said as author and year.
  assert.equal(synth.spoken[2], 'It was late Smith 2019.')
  synth.finish()
  assert.deepEqual(last().state, { status: 'idle', index: -1, total: 0 })
  assert.equal(last().sentence, null)
})

test('starts at the given sentence', () => {
  const { synth, reader, last } = setup()
  reader.start(sentences, 1)
  assert.equal(last().state.index, 1)
  assert.deepEqual(synth.spoken, ['She sat down.'])
})

test('pause silences at once; resume says the sentence again', () => {
  const { synth, reader, last } = setup()
  reader.start(sentences, 0)
  reader.toggle()
  assert.equal(last().state.status, 'paused')
  assert.equal(last().state.index, 0)
  assert.equal(synth.queue.length, 0)
  reader.toggle()
  assert.equal(last().state.status, 'playing')
  assert.deepEqual(synth.spoken, ['Dr. Rao arrived.', 'Dr. Rao arrived.'])
})

test('next and back move by a sentence; next past the end stops', () => {
  const { synth, reader, last } = setup()
  reader.start(sentences, 0)
  reader.next()
  assert.equal(last().state.index, 1)
  assert.equal(synth.spoken.at(-1), 'She sat down.')
  reader.back()
  reader.back() // no further back than the first
  assert.equal(last().state.index, 0)
  reader.next()
  reader.next()
  reader.next()
  assert.equal(last().state.status, 'idle')
})

test('moving while paused stays paused on the new sentence', () => {
  const { synth, reader, last } = setup()
  reader.start(sentences, 0)
  reader.pause()
  const said = synth.spoken.length
  reader.next()
  assert.deepEqual(last().state, { status: 'paused', index: 1, total: 3 })
  assert.equal(synth.spoken.length, said)
  reader.resume()
  assert.equal(synth.spoken.at(-1), 'She sat down.')
})

test('a cancelled sentence ending late never moves the reader on', () => {
  const { synth, reader, last } = setup()
  reader.start(sentences, 0)
  const first = synth.queue[0]
  reader.next() // cancels the first
  first.onend?.() // a browser that sends end after cancel
  assert.equal(last().state.index, 1)
  assert.deepEqual(synth.spoken, ['Dr. Rao arrived.', 'She sat down.'])
})

test('stop silences and clears the highlight', () => {
  const { synth, reader, last } = setup()
  reader.start(sentences, 0)
  reader.stop()
  assert.deepEqual(last().state, { status: 'idle', index: -1, total: 0 })
  assert.equal(last().sentence, null)
  assert.equal(synth.queue.length, 0)
  // Keys after stopping do nothing.
  reader.next()
  reader.toggle()
  assert.equal(last().state.status, 'idle')
})

test('nothing to read: idle at once', () => {
  const { synth, reader, last } = setup()
  reader.start([], 0)
  assert.equal(last().state.status, 'idle')
  assert.equal(synth.spoken.length, 0)
})

test('a long sentence is said in pieces before moving on', () => {
  const { synth, reader, last } = setup()
  const long = Array.from({ length: 40 }, (_, i) => `part ${i}`).join(', ') + '.'
  reader.start([{ text: long, from: 1, to: 1 + long.length }, sentences[1]], 0)
  let pieces = 0
  while (last().state.index === 0 && pieces < 20) {
    pieces++
    synth.finish()
  }
  assert.ok(pieces > 1)
  assert.equal(last().state.index, 1)
})

test('an utterance that fails is skipped rather than stalling', () => {
  const { synth, reader, last } = setup()
  reader.start(sentences, 0)
  synth.queue.shift()!.onerror?.({ error: 'synthesis-failed' })
  assert.equal(last().state.index, 1)
})

test('voice, speed and language go on each utterance', () => {
  const { synth, reader } = setup()
  const voice = { name: 'Lekha', lang: 'hi-IN', voiceURI: 'lekha', localService: true, default: false }
  reader.start(sentences, 0, { voice, rate: 1.2 })
  assert.equal(synth.queue[0].voice, voice)
  assert.equal(synth.queue[0].lang, 'hi-IN')
  assert.equal(synth.queue[0].rate, 1.2)
  reader.setOptions({ rate: 0.8 })
  assert.equal(synth.queue[0].rate, 0.8)
})

// ---- Voices ------------------------------------------------------------------------------------

const v = (name: string, lang: string, local: boolean, def = false): VoiceLike => ({ name, lang, voiceURI: name, localService: local, default: def })
const VOICES = [v('Google UK English Female', 'en-GB', false), v('Samantha', 'en-US', true, true), v('Google français', 'fr-FR', false), v('Amélie', 'fr-CA', true), v('Daniel', 'en-GB', true)]

test('local voices are listed before network ones, which are labelled', () => {
  const names = sortVoices(VOICES).map((x) => x.name)
  assert.deepEqual(names, ['Amélie', 'Daniel', 'Samantha', 'Google français', 'Google UK English Female'])
  assert.equal(voiceLabel(VOICES[0]), 'Google UK English Female (en-GB) · uses the internet')
  assert.equal(voiceLabel(VOICES[1]), 'Samantha (en-US)')
})

test('picks the chosen voice, else the local default', () => {
  assert.equal(pickVoice(VOICES, { chosen: 'Daniel' })?.name, 'Daniel')
  assert.equal(pickVoice(VOICES, {})?.name, 'Samantha')
  assert.equal(pickVoice(VOICES, { chosen: 'gone' })?.name, 'Samantha')
  assert.equal(pickVoice([], {}), null)
})

test('a document in another language is read by a voice for that language', () => {
  assert.equal(pickVoice(VOICES, { chosen: 'Daniel', docLang: 'fr' })?.name, 'Amélie')
  assert.equal(pickVoice(VOICES, { docLang: 'fr-FR' })?.name, 'Amélie')
  // The chosen voice already speaks it: keep it.
  assert.equal(pickVoice(VOICES, { chosen: 'Daniel', docLang: 'en-US' })?.name, 'Daniel')
  // No voice for it: the usual choice.
  assert.equal(pickVoice(VOICES, { chosen: 'Daniel', docLang: 'ja' })?.name, 'Daniel')
})

test('a document language never swaps a voice on this computer for an online one', () => {
  const mixed = [v('Samantha', 'en-US', true, true), v('Google français', 'fr-FR', false)]
  assert.equal(pickVoice(mixed, { docLang: 'fr' })?.name, 'Samantha')
  assert.equal(pickVoice(mixed, { chosen: 'Samantha', docLang: 'fr' })?.name, 'Samantha')
  // The writer chose an online voice already: an online one for the document's language is no new leak.
  const online = [...mixed, v('Google US English', 'en-US', false)]
  assert.equal(pickVoice(online, { chosen: 'Google US English', docLang: 'fr' })?.name, 'Google français')
  // A local voice anywhere beats an online one for the system language.
  assert.equal(pickVoice([v('Google US English', 'en-US', false), v('Thomas', 'fr-FR', true)], { systemLang: 'en-US' })?.name, 'Thomas')
  assert.equal(isOnlineVoice(mixed[1]), true)
  assert.equal(isOnlineVoice(mixed[0]), false)
})

test('only network voices: one of them is used', () => {
  const online = [v('Google US English', 'en-US', false), v('Google Deutsch', 'de-DE', false)]
  assert.equal(pickVoice(online, { systemLang: 'en-US' })?.name, 'Google US English')
  assert.equal(pickVoice(online, {})?.localService, false)
})
