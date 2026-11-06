// The length count in the status bar, and the small sheet behind it where a writer sets a limit
// (typed, or a preset like UCAS) and copies the piece for a form. Everything counted here, with or
// without a limit, is formText(): the same text "Copy for a form" copies, so template prompts and
// Markdown never count and setting a limit never changes the number.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { countChars, countWords, formText } from '../lib/count.ts'
import { formatTarget, parseTarget, pagesFromWords, presetOf, PRESETS, progress, unitLabel, type Target } from '../lib/targets.ts'

/** The open piece's whole file, kept outside React state so typing re-renders only the count. */
export function textStore() {
  let text = ''
  const listeners = new Set<() => void>()
  return {
    get: () => text,
    set(next: string) {
      if (next === text) return
      text = next
      listeners.forEach((l) => l())
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}
export type TextStore = ReturnType<typeof textStore>

interface Props {
  store: TextStore
  /** The target as written in front matter, or '' for none. */
  target: string
  /** Words selected in the editor, or 0. */
  selectedWords: number
  /** The help ceiling: the ⌘5 hint only shows when Passage help is allowed. */
  ceiling: number
  mod: string
  paper: 'letter' | 'a4'
  /** A [[link]]'s page, so links count as the text they show. */
  page: (target: string) => { title: string; path: string } | null
  onTarget: (target: string | null) => void
}

const n = (x: number) => x.toLocaleString('en-US')
/** Big pieces are counted after a short pause, so typing never waits on the count. */
const BIG = 60_000

/** How many units a target's count is, from the text a form receives. */
export function measure(text: string, t: Target, paper: 'letter' | 'a4') {
  if (t.unit === 'characters') return countChars(text, { noSpaces: t.noSpaces })
  const words = countWords(text)
  return t.unit === 'pages' ? pagesFromWords(words, paper) : words
}

export function LimitStatus({ store, target, selectedWords, ceiling, mod, paper, page, onTarget }: Props) {
  const content = useSyncExternalStore(store.subscribe, store.get)
  const [open, setOpen] = useState(false)
  const t = parseTarget(target)
  const live = t && t !== 'invalid' ? t : null

  // The text a form would get. Short pieces are counted on every keystroke; long ones after a pause.
  const [settled, setSettled] = useState(content)
  useEffect(() => {
    if (content.length < BIG) return setSettled(content)
    const id = window.setTimeout(() => setSettled(content), 250)
    return () => window.clearTimeout(id)
  }, [content])
  const pageRef = useRef(page)
  pageRef.current = page
  const text = useMemo(() => formText(content.length < BIG ? content : settled, (x) => pageRef.current(x)), [content, settled])
  const words = useMemo(() => countWords(text), [text])
  const count = live ? (live.unit === 'words' ? words : measure(text, live, paper)) : 0
  const p = live ? progress(count, live) : null

  let label: string
  if (selectedWords && (!live || live.unit !== 'characters')) label = `${n(selectedWords)} of ${n(words)} words`
  else if (!live) label = t === 'invalid' ? `${n(words)} words / ?` : `${n(words)} words`
  else if (live.unit === 'pages') label = `≈ ${n(count)} / ${formatTarget(live)} pages`
  else label = `${n(count)} / ${formatTarget(live)} ${unitLabel(live)}`

  const over = p?.state === 'over'
  const title =
    t === 'invalid'
      ? `The limit “${target}” isn’t understood. Click to change it`
      : over && live
        ? `${n(count - live.max!)} over the limit.${ceiling >= 5 ? ` Select a part to trim, then ${mod}5` : ''}`
        : live
          ? `Limit: ${target}. Click to change it or copy for a form`
          : 'Set a length limit'

  return (
    <span className="lm">
      <button className={`lm-count${p ? ` is-${p.state}${live?.unit === 'characters' ? ' is-hard' : ''}` : ''}`} title={title} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
        {p && (
          <span className="lm-progress" aria-hidden="true">
            <i style={{ width: `${p.fill * 100}%` }} />
          </span>
        )}
      </button>
      {open && <LimitSheet target={target} store={store} page={page} onTarget={onTarget} onClose={() => setOpen(false)} />}
    </span>
  )
}

/** Write a typed limit unless it is unchanged or can't be read. An emptied field removes the limit. */
function commitLimit(v: string, target: string, onTarget: Props['onTarget']) {
  const next = v.trim()
  if (next === target.trim()) return
  if (next && parseTarget(next) === 'invalid') return
  onTarget(next || null)
}

/** Set a limit, pick a preset, or copy the piece as a form gets it. */
function LimitSheet({ target, store, page, onTarget, onClose }: { target: string; store: TextStore; page: Props['page']; onTarget: Props['onTarget']; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(target)
  // The latest draft and limit, read when the sheet goes away, however it goes away.
  const latest = useRef({ draft, target, onTarget })
  latest.current = { draft, target, onTarget }
  const [copied, setCopied] = useState<{ ok: true; count: number } | { ok: false; text: string } | null>(null)
  useEffect(() => setDraft(target), [target])
  const preset = presetOf(target)
  const parsed = parseTarget(draft)

  // In a narrow window the status bar's count can sit near the right edge: keep the sheet on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const over = el.getBoundingClientRect().right - (window.innerWidth - 8)
    if (over > 0) el.style.left = `${el.offsetLeft - over}px`
  }, [])

  // Click outside, clicking the count again or opening another piece closes the sheet, and whatever was
  // typed is kept if it reads as a limit. The sheet is gone before the input could blur, so the save
  // happens as it unmounts. Escape is the one way out that drops what was typed.
  useEffect(
    () => () => {
      const { draft, target, onTarget } = latest.current
      commitLimit(draft, target, onTarget)
    },
    [],
  )
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('.lm-count')) onClose()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      latest.current.draft = latest.current.target
      onClose()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])

  const commit = (v: string) => commitLimit(v, latest.current.target, onTarget)

  const copy = async () => {
    const text = formText(store.get(), page)
    const t = parseTarget(target)
    try {
      await navigator.clipboard.writeText(text)
      setCopied({ ok: true, count: t && t !== 'invalid' && t.unit === 'characters' ? countChars(text, { noSpaces: t.noSpaces }) : countWords(text) })
    } catch {
      setCopied({ ok: false, text })
    }
  }
  const t = parseTarget(target)
  const copiedUnit = t && t !== 'invalid' && t.unit === 'characters' ? unitLabel(t) : 'words'

  return (
    <div className="lm-sheet" ref={ref} role="dialog" aria-label="Length limit">
      <label className="lm-field">
        <span>Length limit</span>
        <input
          ref={input}
          value={draft}
          autoFocus={!target}
          placeholder="4000 characters, 650 words, ≤ 250 words"
          aria-invalid={parsed === 'invalid'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value)
            else if (e.key === 'Escape') setDraft((latest.current.draft = target))
          }}
        />
      </label>
      {parsed === 'invalid' && <p className="lm-hint is-bad">Try “4000 characters”, “4000 characters no spaces”, “650 words” or “≤ 250 words”.</p>}
      <div className="lm-presets" role="radiogroup" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.id} role="radio" aria-checked={preset?.id === p.id} className={preset?.id === p.id ? 'is-on' : ''} title={p.note} onClick={() => onTarget(p.target)}>
            {p.label}
          </button>
        ))}
        <button
          role="radio"
          aria-checked={!preset && !!target}
          className={!preset && target ? 'is-on' : ''}
          onClick={() => {
            input.current?.focus()
            input.current?.select()
          }}
        >
          Custom
        </button>
      </div>
      {preset && <p className="lm-hint">{preset.note}</p>}
      <div className="lm-actions">
        <button className="btn" onClick={copy} title="Plain text with straight quotes, counted the same way as the status bar">
          Copy for a form
        </button>
        {target && (
          <button className="lm-remove" onClick={() => onTarget(null)}>
            Remove limit
          </button>
        )}
      </div>
      {copied?.ok && (
        <p className="lm-hint" role="status">
          Copied {n(copied.count)} {copiedUnit}.
        </p>
      )}
      {copied && !copied.ok && (
        <>
          <p className="lm-hint" role="status">
            Copying isn’t allowed here. Select this and copy it:
          </p>
          <textarea className="lm-fallback" readOnly value={copied.text} ref={(el) => el?.select()} />
        </>
      )}
    </div>
  )
}
