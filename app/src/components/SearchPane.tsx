import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type MeaningHit, type Range, type SearchResult } from '../lib/api.ts'
import { hasPositive, plainLine, ready } from '../lib/searchQuery.ts'
import { binding, formatKey } from '../lib/keys.ts'
import { Icon } from './Icon.tsx'

export interface SearchState {
  query: string
  matchCase: boolean
  meaning: boolean
}

export interface SearchProps {
  state: SearchState
  onState: (patch: Partial<SearchState>) => void
  /** Bumped by ⌘⇧F, to put the caret back in the box. */
  focusTick: number
  current: string | null
  /** Open a document and select a match in it (or just open it, without `select`). */
  onReveal: (path: string, select?: { text: string; nth: number }) => void
  onClose: () => void
}

const PAGE = 200

/** Search across the vault: a sidebar mode that shows only while it's in use (⌘⇧F). */
export function SearchPane({ state, onState, focusTick, current, onReveal, onClose }: SearchProps) {
  const { query, matchCase, meaning } = state
  const input = useRef<HTMLInputElement>(null)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const [help, setHelp] = useState(false)
  const [meaningReady, setMeaningReady] = useState(false)
  const [meaningHits, setMeaningHits] = useState<MeaningHit[] | null>(null)
  const request = useRef(0)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusTick])

  const { query: parsed, ok } = ready(query)
  const error = parsed.error

  // The vault's words: 200 ms after typing stops, ignoring any answer to an older query.
  useEffect(() => setLimit(PAGE), [query, matchCase])
  useEffect(() => {
    if (!ok) {
      request.current++
      setResult(null)
      setLoading(false)
      return
    }
    const id = ++request.current
    setLoading(true)
    const timer = window.setTimeout(() => {
      api
        .search(query, { matchCase, limit })
        .then((r) => id === request.current && setResult(r))
        .catch(() => id === request.current && setResult({ files: [], total: 0, matches: 0, documents: 0, more: false, error: 'Search failed. Is Ekdanta still running?' }))
        .finally(() => id === request.current && setLoading(false))
    }, 200)
    return () => window.clearTimeout(timer)
  }, [query, matchCase, limit, ok])

  // By meaning: Recall's index, once it has been built. Asked about until it is.
  useEffect(() => {
    if (meaningReady) return
    let stop = false
    let timer: number | undefined
    const check = () =>
      api
        .searchMeaning('')
        .then((r) => !stop && (r.ready ? setMeaningReady(true) : (timer = window.setTimeout(check, 3000))))
        .catch(() => !stop && (timer = window.setTimeout(check, 5000)))
    check()
    return () => {
      stop = true
      window.clearTimeout(timer)
    }
  }, [meaningReady])
  const meaningText = parsed.terms
    .filter((t) => !t.negate && t.type === 'text')
    .map((t) => (t.type === 'text' ? t.value : ''))
    .join(' ')
  const meaningRequest = useRef(0)
  useEffect(() => {
    setMeaningHits(null)
    if (!meaning || !meaningReady || meaningText.trim().length < 2 || error) return
    const id = ++meaningRequest.current
    const timer = window.setTimeout(() => {
      api
        .searchMeaning(meaningText)
        .then((r) => id === meaningRequest.current && setMeaningHits(r.results))
        .catch(() => id === meaningRequest.current && setMeaningHits([]))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [meaning, meaningReady, meaningText, error])

  const shownHits = result ? result.files.reduce((n, f) => n + Math.max(1, f.hits.length), 0) : 0

  return (
    <div className="search-pane">
      <div className="search-head">
        <span className="section-label">Search</span>
        <button className="icon-btn small" title="Close search, back to the Vault" aria-label="Close search" onClick={onClose}>
          ×
        </button>
      </div>
      <div className={`search-box${error ? ' has-error' : ''}`}>
        <Icon name="search" />
        <input
          ref={input}
          value={query}
          placeholder="Search the vault"
          aria-label="Search the vault"
          aria-invalid={!!error}
          spellCheck={false}
          onChange={(e) => onState({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              if (query) onState({ query: '' })
              else onClose()
            } else if (e.key === 'Enter' && result?.files[0]) {
              const f = result.files[0]
              onReveal(f.path, f.hits[0]?.select)
            }
          }}
        />
        <button className={`search-opt${matchCase ? ' is-on' : ''}`} aria-pressed={matchCase} title="Match case and accents" onClick={() => onState({ matchCase: !matchCase })}>
          Aa
        </button>
      </div>
      {error && (
        <p className="search-error" role="alert">
          {error}
        </p>
      )}
      <div className="search-tools">
        <label
          className={`search-meaning${meaningReady ? '' : ' is-off'}`}
          title={meaningReady ? 'Also find passages that mean something close, through Recall' : 'Recall is still building its index'}
        >
          <input type="checkbox" checked={meaning && meaningReady} disabled={!meaningReady} onChange={(e) => onState({ meaning: e.target.checked })} />
          By meaning
        </label>
        <button className="search-help-btn" aria-expanded={help} title="How to search" onClick={() => setHelp((h) => !h)}>
          ?
        </button>
      </div>
      {help && (
        <dl className="search-help">
          <dt>"a phrase"</dt>
          <dd>these words together</dd>
          <dt>-word</dt>
          <dd>leave out documents with it</dd>
          <dt>/wr[io]te/</dt>
          <dd>a regular expression</dd>
          <dt>path:essays</dt>
          <dd>in this folder or path</dd>
          <dt>kind:essay</dt>
          <dd>this kind of writing</dd>
          <dt>tag:craft</dt>
          <dd>tagged (also craft/…)</dd>
          <dt>status:draft</dt>
          <dd>drafts, or any status</dd>
        </dl>
      )}

      {result && !error && (
        <p className="search-count muted" aria-live="polite">
          {countLine(result)}
          {loading && ' …'}
        </p>
      )}
      {!query.trim() && !help && (
        <p className="sidebar-hint">
          Words, "phrases", -exclusions, /regex/, path:, kind:, tag:, status:. <span className="nowrap">{formatKey(binding('search'))}</span> comes back here.
        </p>
      )}
      {query.trim().length === 1 && <p className="sidebar-hint">Keep typing…</p>}
      {query.trim().length > 1 && !error && !hasPositive(parsed) && (
        <p className="sidebar-hint">A -word only leaves documents out. Add a word, a "phrase" or a filter such as kind:essay to search for.</p>
      )}

      {result?.files.map((f) => (
        <div key={f.path} className="search-file">
          <button className={`search-title${f.path === current ? ' is-current' : ''}`} onClick={() => onReveal(f.path, f.hits[0]?.select)} title={f.path}>
            <span>{marked(f.title, f.titleRanges)}</span>
            {f.folder && <small className="muted">{f.folder}</small>}
          </button>
          {f.hits.map((h) => (
            <button key={h.line} className="search-hit" onClick={() => onReveal(f.path, h.select)}>
              {marked(h.text, h.ranges)}
            </button>
          ))}
        </div>
      ))}
      {result?.more && (
        <button className="search-more" onClick={() => setLimit((l) => l + PAGE)}>
          More…{' '}
          <span className="muted">
            {(result.total - shownHits).toLocaleString()} more {result.total - shownHits === 1 ? 'line' : 'lines'}
          </span>
        </button>
      )}

      {meaning && meaningReady && meaningHits && (
        <div className="search-meaning-results">
          <div className="search-section">By meaning</div>
          {meaningHits.map((m, i) => (
            <button key={m.doc + i} className="search-hit is-meaning" onClick={() => onReveal(m.doc, firstWords(m.text))}>
              <b>{m.title}</b> {clip(plainLine(m.text.split('\n')[0]), 110)}
            </button>
          ))}
          {!meaningHits.length && <p className="sidebar-hint">Nothing close in meaning.</p>}
        </div>
      )}
    </div>
  )
}

/** "12 matches in 3 documents": occurrences, not lines. A search by filters alone (kind:essay) counts documents. */
function countLine(r: SearchResult) {
  const docs = `${r.documents.toLocaleString()} ${r.documents === 1 ? 'document' : 'documents'}`
  if (!r.documents) return 'No matches'
  if (!r.matches) return docs
  return `${r.matches.toLocaleString()} ${r.matches === 1 ? 'match' : 'matches'} in ${docs}`
}

/** Text with its matches marked. */
function marked(text: string, ranges: Range[]): ReactNode {
  if (!ranges.length) return text
  const out: ReactNode[] = []
  let at = 0
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a))
    out.push(<mark key={i}>{text.slice(a, b)}</mark>)
    at = b
  })
  if (at < text.length) out.push(text.slice(at))
  return out
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, s.lastIndexOf(' ', n) > n / 2 ? s.lastIndexOf(' ', n) : n) + '…' : s)

/** A passage found by meaning is selected by its opening words. */
function firstWords(text: string) {
  const line = plainLine(text.split('\n')[0]).trim()
  const cut = line.length > 48 ? line.slice(0, line.lastIndexOf(' ', 48) > 20 ? line.lastIndexOf(' ', 48) : 48) : line
  return cut ? { text: cut, nth: 0 } : undefined
}
