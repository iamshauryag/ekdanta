// Read aloud in the browser: the voices this computer has, the writer's voice and speed, and the
// small player that floats over the page while a document is being read.
import { useEffect, useRef, useState } from 'react'
import type { Editor as TiptapEditor } from '@tiptap/core'
import { Reader, isOnlineVoice, pickVoice, sortVoices, type ReaderState, type Sentence, type SynthLike, type UtteranceLike, type VoiceLike } from '../lib/speak.ts'
import { readableSentences, setReading, startIndex } from '../editor/readAloud.ts'

// ---- The browser's speech, and its voices ---------------------------------------------------------

const synth = (): SpeechSynthesis | null => (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null)

/** The voices this browser can read with. They arrive a moment after the page loads in Chrome, so this follows them. */
export function useSpeechVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => synth()?.getVoices() ?? [])
  useEffect(() => {
    const s = synth()
    if (!s) return
    const update = () => setVoices(s.getVoices())
    update()
    s.addEventListener('voiceschanged', update)
    // Some browsers never send voiceschanged; look once more after they've had time to load.
    const t = window.setTimeout(update, 1500)
    return () => {
      s.removeEventListener('voiceschanged', update)
      window.clearTimeout(t)
    }
  }, [])
  return voices
}

/** Can this browser read aloud at all? (No speech engine, or no voices installed: no.) */
export const canReadAloud = (voices: readonly unknown[]) => !!synth() && voices.length > 0

// ---- The writer's voice and speed: kept on this computer, since voices differ from one to the next ----

export interface ReadPrefs {
  /** A voiceURI, or '' for the automatic choice. */
  voice: string
  rate: number
}
export const RATES = [0.8, 1, 1.2, 1.5] as const
const PREFS_KEY = 'ekdanta.readAloud'

export function readPrefs(): ReadPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<ReadPrefs>
    return { voice: typeof p.voice === 'string' ? p.voice : '', rate: typeof p.rate === 'number' && p.rate >= 0.5 && p.rate <= 2 ? p.rate : 1 }
  } catch {
    return { voice: '', rate: 1 }
  }
}
export function saveReadPrefs(patch: Partial<ReadPrefs>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }))
  } catch {
    /* preferences are a convenience */
  }
  window.dispatchEvent(new Event('ekdanta:read-prefs'))
}

/** The voices in the order Settings lists them: this computer's first, then the online ones. */
export const listedVoices = (voices: readonly SpeechSynthesisVoice[]) => sortVoices(voices)

/** Say a short sample with a voice and speed, for Settings. */
export function sample(voice: SpeechSynthesisVoice | null, rate: number) {
  const s = synth()
  if (!s) return
  // A document being read pauses first, so its player doesn't go on saying it is playing.
  window.dispatchEvent(new Event('ekdanta:read-pause'))
  s.cancel()
  const u = new SpeechSynthesisUtterance('This is how your writing will sound.')
  if (voice) {
    u.voice = voice
    u.lang = voice.lang
  }
  u.rate = rate
  s.speak(u)
}

// ---- Reading the open document ----------------------------------------------------------------------

/** What starts reading: the page's caret or selection. */
export const readAloud = () => window.dispatchEvent(new Event('ekdanta:read-aloud'))

const IDLE: ReaderState = { status: 'idle', index: -1, total: 0 }

/**
 * Reading the document in an editor aloud. Starts at the caret (or reads just the selection);
 * Space pauses, ← and → move by sentence, Esc stops. Any change to the text, or a click in it,
 * stops reading. Unmounting (another document, the Markdown view) stops it too.
 */
export function useReadAloud(editor: TiptapEditor | null, opts: { lang: () => string | undefined; onUnavailable: () => void }) {
  const [state, setState] = useState<ReaderState>(IDLE)
  /** Is the voice in use an online one? The player says so. */
  const [online, setOnline] = useState(false)
  const reader = useRef<Reader | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts
  const voices = useSpeechVoices()
  const voicesRef = useRef(voices)
  voicesRef.current = voices

  const options = () => {
    const prefs = readPrefs()
    const docLang = optsRef.current.lang()
    const voice = pickVoice(voicesRef.current as unknown as VoiceLike[], { chosen: prefs.voice, docLang, systemLang: navigator.language })
    setOnline(isOnlineVoice(voice))
    return { voice, rate: prefs.rate, lang: docLang }
  }

  useEffect(() => {
    const s = synth()
    if (!editor || !s) return
    const show = (sentence: Sentence | null) => {
      if (editor.isDestroyed) return
      editor.view.dispatch(setReading(editor.state.tr, sentence && { from: sentence.from, to: sentence.to }))
      if (sentence) scrollToReading(editor)
    }
    const r = new Reader(
      s as unknown as SynthLike,
      (text) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
      (st, sentence) => {
        setState(st)
        show(sentence)
      },
    )
    reader.current = r

    const start = () => {
      if (!canReadAloud(voicesRef.current)) return optsRef.current.onUnavailable()
      const { from, to, empty } = editor.state.selection
      const all = readableSentences(editor.state.doc)
      if (empty) r.start(all, startIndex(all, from), options())
      else r.start(readableSentences(editor.state.doc, from, to), 0, options())
    }
    const prefsChanged = () => r.state.status !== 'idle' && r.setOptions(options())
    const pause = () => r.pause()

    // While reading, these keys steer it; everything else goes where it always does.
    const onKey = (e: KeyboardEvent) => {
      if (r.state.status === 'idle' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const t = e.target as HTMLElement | null
      // Typing in a field elsewhere (the title, Settings, find) is left alone.
      if (t && t !== document.body && !editor.view.dom.contains(t) && !t.closest('.read-bar')) return
      const act = e.key === ' ' ? () => r.toggle() : e.key === 'ArrowRight' ? () => r.next() : e.key === 'ArrowLeft' ? () => r.back() : e.key === 'Escape' ? () => stopHere() : null
      if (!act) return
      e.preventDefault()
      // Esc stops reading only; it doesn't also leave Focus mode or close a help card.
      e.stopPropagation()
      act()
    }
    /** Stop, leaving the caret at the start of the sentence that was being read, so it can be fixed or read again. */
    const stopHere = () => {
      const at = r.sentence?.from
      r.stop()
      if (at !== undefined && !editor.isDestroyed) editor.chain().focus().setTextSelection(at).run()
    }
    const onPointer = (e: MouseEvent) => {
      if (r.state.status !== 'idle' && editor.view.dom.contains(e.target as Node)) r.stop()
    }
    // Text changed while reading (typing, pasting, help accepted): what was planned no longer matches the page.
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged && r.state.status !== 'idle') r.stop()
    }

    window.addEventListener('ekdanta:read-aloud', start)
    window.addEventListener('ekdanta:read-prefs', prefsChanged)
    window.addEventListener('ekdanta:read-pause', pause)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onPointer, true)
    editor.on('transaction', onTransaction)
    return () => {
      window.removeEventListener('ekdanta:read-aloud', start)
      window.removeEventListener('ekdanta:read-prefs', prefsChanged)
      window.removeEventListener('ekdanta:read-pause', pause)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onPointer, true)
      editor.off('transaction', onTransaction)
      r.stop()
      reader.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Stop when the page goes away for good (closing the tab mid-sentence).
  useEffect(() => {
    const off = () => reader.current?.stop()
    window.addEventListener('pagehide', off)
    return () => window.removeEventListener('pagehide', off)
  }, [])

  return { state, voices, reader, online }
}

/** Keep the sentence being read on screen, without jumping when it already is. */
function scrollToReading(editor: TiptapEditor) {
  requestAnimationFrame(() => {
    const el = editor.view.dom.querySelector('.read-now')
    if (!el) return
    const box = el.getBoundingClientRect()
    const margin = 80
    if (box.top < margin || box.bottom > window.innerHeight - margin) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}

// ---- The player -------------------------------------------------------------------------------------

export function ReadAloudBar({ state, reader, online = false }: { state: ReaderState; reader: Reader | null; online?: boolean }) {
  if (state.status === 'idle' || !reader) return null
  const keep = (fn: () => void) => (e: React.MouseEvent) => {
    // The caret stays where it is, so the keys keep working.
    e.preventDefault()
    fn()
  }
  const playing = state.status === 'playing'
  return (
    <div className="read-bar" role="toolbar" aria-label="Reading aloud">
      <button title="Back a sentence (←)" aria-label="Back a sentence" onMouseDown={keep(() => reader.back())} disabled={state.index <= 0}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 3v10M13 3.5 6 8l7 4.5z" />
        </svg>
      </button>
      <button className="read-play" title={playing ? 'Pause (Space)' : 'Resume (Space)'} aria-label={playing ? 'Pause' : 'Resume'} onMouseDown={keep(() => reader.toggle())}>
        {playing ? (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 3.5v9M11 3.5v9" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 3l8 5-8 5z" />
          </svg>
        )}
      </button>
      <button title="Next sentence (→)" aria-label="Next sentence" onMouseDown={keep(() => reader.next())}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M12 3v10M3 3.5 10 8l-7 4.5z" />
        </svg>
      </button>
      <span className="read-count" aria-live="polite">
        {state.index + 1} of {state.total}
      </span>
      {online && (
        <span className="read-online" title="This voice sends the text it reads to an online service. Pick a voice on this computer in Settings to keep it here.">
          Online voice
        </span>
      )}
      <button title="Stop (Esc)" aria-label="Stop reading" onMouseDown={keep(() => reader.stop())}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="4" y="4" width="8" height="8" rx="1" />
        </svg>
      </button>
    </div>
  )
}
