// Reading a document aloud with the browser's own speech (speechSynthesis): no model, no account.
// One utterance per sentence (long ones in a few pieces), so pausing, skipping and stopping are
// instant, and Chrome's cut-off for long utterances never bites. The browser is passed in, so this
// file has no DOM and the tests can drive it with a fake.

import { chunkForSpeech, spokenText } from './sentences.ts'

// ---- The browser's side, as much of it as we use ----------------------------------------------

export interface VoiceLike {
  name: string
  lang: string
  voiceURI: string
  localService: boolean
  default: boolean
}

export interface UtteranceLike {
  text: string
  lang: string
  rate: number
  voice: VoiceLike | null
  onend: ((e?: unknown) => void) | null
  onerror: ((e?: { error?: string }) => void) | null
}

export interface SynthLike {
  speak(u: UtteranceLike): void
  cancel(): void
  getVoices(): VoiceLike[]
}

// ---- Voices -----------------------------------------------------------------------------------

/** Voices that run on this computer first (they work offline and send nothing anywhere), then the rest; each group by name. */
export function sortVoices<V extends VoiceLike>(voices: readonly V[]): V[] {
  return [...voices].sort((a, b) => Number(b.localService) - Number(a.localService) || a.name.localeCompare(b.name))
}

/** A voice as the Settings list shows it. Online voices say so, as dictation does. */
export const voiceLabel = (v: VoiceLike) => `${v.name} (${v.lang})${v.localService ? '' : ' · uses the internet'}`

const primary = (lang: string) => lang.toLowerCase().split(/[-_]/)[0]

/**
 * Which voice reads a document. The writer's chosen voice; with no choice made, the system's
 * default voice if it runs on this computer, else a local voice for the system language, else any
 * local voice, and an online voice only when the computer has none. A document that says it is in
 * another language (front matter `lang`) is read by a voice for that language instead, but never
 * by trading a voice on this computer for an online one: the writer would not know their text
 * was leaving the machine.
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], opts: { chosen?: string; docLang?: string; systemLang?: string }): V | null {
  if (!voices.length) return null
  const chosen = opts.chosen ? voices.find((v) => v.voiceURI === opts.chosen) : undefined
  const usual = chosen ?? autoVoice(voices, opts.systemLang)
  if (opts.docLang && primary(usual.lang) !== primary(opts.docLang)) return voiceFor(voices, opts.docLang, !usual.localService) ?? usual
  return usual
}

/** Does reading with this voice send the text somewhere? */
export const isOnlineVoice = (v: VoiceLike | null | undefined) => !!v && !v.localService

function autoVoice<V extends VoiceLike>(voices: readonly V[], systemLang?: string): V {
  const local = voices.filter((v) => v.localService)
  const def = local.find((v) => v.default)
  if (def) return def
  if (local.length) return (systemLang ? voiceFor(local, systemLang, false) : undefined) ?? sortVoices(local)[0]
  return (systemLang ? voiceFor(voices, systemLang, true) : undefined) ?? sortVoices(voices)[0]
}

/** The best voice for a language: this computer's (exact region, then default, then any), and an online one only when allowed. */
function voiceFor<V extends VoiceLike>(voices: readonly V[], lang: string, online: boolean): V | undefined {
  const norm = (l: string) => l.toLowerCase().replace('_', '-')
  const want = norm(lang)
  const same = sortVoices(voices.filter((v) => primary(v.lang) === primary(want) && (online || v.localService)))
  return same.find((v) => norm(v.lang) === want && v.localService) ?? same.find((v) => v.localService && v.default) ?? same.find((v) => v.localService) ?? same[0]
}

// ---- The reader -------------------------------------------------------------------------------

export interface Sentence {
  /** Exactly what is on the page. */
  text: string
  /** Where it is (document positions), for the highlight. */
  from: number
  to: number
}

export type ReaderStatus = 'idle' | 'playing' | 'paused'

export interface ReaderState {
  status: ReaderStatus
  /** The sentence being read (or paused on), or -1. */
  index: number
  total: number
}

export interface ReaderOptions {
  voice?: VoiceLike | null
  /** 1 is normal speed. */
  rate?: number
  lang?: string
}

/**
 * Reads a list of sentences one at a time. Pausing cancels the sentence and resuming starts it
 * again, which every browser does reliably (speechSynthesis.pause() is unreliable in Chrome,
 * especially with online voices). Each utterance carries a token, so the end of one that was
 * cancelled can never move the reader on.
 */
export class Reader {
  private sentences: Sentence[] = []
  private index = -1
  private status: ReaderStatus = 'idle'
  private token = 0
  private opts: ReaderOptions = {}
  /** Kept so the browser can't drop it before it finishes (Chrome then never sends its end). */
  private current: UtteranceLike | null = null

  private synth: SynthLike
  private makeUtterance: (text: string) => UtteranceLike
  private onChange: (s: ReaderState, sentence: Sentence | null) => void

  constructor(synth: SynthLike, makeUtterance: (text: string) => UtteranceLike, onChange: (s: ReaderState, sentence: Sentence | null) => void) {
    this.synth = synth
    this.makeUtterance = makeUtterance
    this.onChange = onChange
  }

  get state(): ReaderState {
    return { status: this.status, index: this.index, total: this.sentences.length }
  }
  get sentence(): Sentence | null {
    return this.sentences[this.index] ?? null
  }

  start(sentences: Sentence[], at = 0, opts: ReaderOptions = {}) {
    this.halt()
    this.sentences = sentences
    this.opts = opts
    if (!sentences.length) return this.finish()
    this.play(Math.max(0, Math.min(sentences.length - 1, at)))
  }

  pause() {
    if (this.status !== 'playing') return
    this.halt()
    this.status = 'paused'
    this.emit()
  }
  resume() {
    if (this.status === 'paused') this.play(this.index)
  }
  toggle() {
    if (this.status === 'playing') this.pause()
    else this.resume()
  }

  /** The next or previous sentence; keeps playing, or stays paused on it. */
  move(by: number) {
    if (this.status === 'idle') return
    const to = this.index + by
    if (to >= this.sentences.length) return this.finish()
    const target = Math.max(0, to)
    if (this.status === 'paused') {
      this.index = target
      this.emit()
    } else this.play(target)
  }
  next() {
    this.move(1)
  }
  back() {
    this.move(-1)
  }

  stop() {
    if (this.status === 'idle') return
    this.finish()
  }

  /** Change voice or speed mid-way: the current sentence starts again with it. */
  setOptions(opts: ReaderOptions) {
    this.opts = { ...this.opts, ...opts }
    if (this.status === 'playing') this.play(this.index)
  }

  private play(i: number) {
    this.halt()
    this.index = i
    this.status = 'playing'
    this.emit()
    const chunks = chunkForSpeech(spokenText(this.sentences[i].text))
    this.speakChunks(chunks, 0, this.token)
  }

  private speakChunks(chunks: string[], k: number, token: number) {
    if (token !== this.token) return
    if (k >= chunks.length) return this.advance(token)
    const u = this.makeUtterance(chunks[k])
    if (this.opts.voice) u.voice = this.opts.voice
    u.lang = this.opts.voice?.lang ?? this.opts.lang ?? ''
    u.rate = this.opts.rate ?? 1
    u.onend = () => this.speakChunks(chunks, k + 1, token)
    u.onerror = (e) => {
      if (token !== this.token) return
      // Our own cancels never get here (halt() moves the token on first). Cancelled by something
      // else on the page (the Settings sample): stop here as paused, so the player tells the truth
      // and resuming reads the sentence again. Anything else: skip what can't be said rather than stall.
      if (e?.error === 'interrupted' || e?.error === 'canceled') return this.interrupted()
      this.speakChunks(chunks, k + 1, token)
    }
    this.current = u
    this.synth.speak(u)
  }

  private interrupted() {
    this.token++
    this.current = null
    this.status = 'paused'
    this.emit()
  }

  private advance(token: number) {
    if (token !== this.token) return
    if (this.index + 1 >= this.sentences.length) return this.finish()
    this.play(this.index + 1)
  }

  /** Silence whatever is being said, and make its late events harmless. */
  private halt() {
    this.token++
    this.current = null
    this.synth.cancel()
  }

  private finish() {
    this.halt()
    this.status = 'idle'
    this.index = -1
    this.sentences = []
    this.emit()
  }

  private emit() {
    this.onChange(this.state, this.sentence)
  }
}
