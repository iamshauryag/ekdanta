import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type ImportPlan, type Source, type Touched } from '../lib/api.ts'
import { SOURCE_TYPES, STATUS_LABELS, TYPE_LABELS, formatLocation, type SourceType } from '../lib/brain.ts'
import { AddSource, Dialog } from './AddSource.tsx'
import { helpMod } from '../editor/help.ts'

interface Props {
  folder: string
  onOpenDoc: (path: string) => void
  /** Runs a write to the vault after the open document is saved, with its autosave held until the write is done. */
  run: <T>(job: () => Promise<T>) => Promise<T>
  /** Notes in the vault were added or rewritten: the sidebar, and an open note, should catch up. */
  onChanged: (touched: Touched[]) => void
}

type Column = 'type' | 'title' | 'author' | 'status' | 'rating' | 'finished' | 'tags' | 'highlights'
const COLUMNS: { id: Column; label: string }[] = [
  { id: 'type', label: 'Type' },
  { id: 'title', label: 'Title' },
  { id: 'author', label: 'Author' },
  { id: 'status', label: 'Status' },
  { id: 'rating', label: 'Rating' },
  { id: 'finished', label: 'Finished' },
  { id: 'tags', label: 'Tags' },
  { id: 'highlights', label: 'Highlights' },
]
const GROUP_LABELS: Record<SourceType, string> = { book: 'Books', podcast: 'Podcasts', video: 'Videos', article: 'Articles' }
const STATUS_ORDER = { want: 1, reading: 2, done: 3, '': 0 }

function usePref<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem('ekdanta.' + key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('ekdanta.' + key, JSON.stringify(value))
    } catch {
      /* preferences are a convenience */
    }
  }, [key, value])
  return [value, setValue] as const
}

const matchesQuery = (s: Source, q: string) => !q || [s.title, s.author, s.tags, s.year].some((v) => v?.toLowerCase().includes(q))

/** The Brain: what the writer read, heard and watched, as a shelf or a table, and the way in for new sources and highlights. */
export function BrainPage({ folder, onOpenDoc, run, onChanged }: Props) {
  const [sources, setSources] = useState<Source[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = usePref<'shelf' | 'table'>('brainView', 'shelf')
  const [sort, setSort] = usePref<{ col: Column; dir: 1 | -1 }>('brainSort', { col: 'title', dir: 1 })
  const [typeFilter, setTypeFilter] = useState<SourceType | ''>('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [adding, setAdding] = useState(false)
  const [highlightFor, setHighlightFor] = useState<Source | null>(null)
  const [importing, setImporting] = useState<{ name: string; text: string; plan: ImportPlan | null; busy: boolean; error?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fresh, setFresh] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const noticeTimer = useRef<number | undefined>(undefined)

  const load = () =>
    api
      .brain()
      .then((s) => {
        setSources(s)
        setError(null)
      })
      .catch((e) => setError((e as Error).message))
  useEffect(() => {
    load()
  }, [folder])

  const say = (text: string) => {
    window.clearTimeout(noticeTimer.current)
    setNotice(text)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000)
  }

  const q = query.trim().toLowerCase()
  const shown = useMemo(() => (sources ?? []).filter((s) => matchesQuery(s, q)), [sources, q])
  const rows = useMemo(() => {
    const out = shown.filter((s) => (!typeFilter || s.type === typeFilter) && (!statusFilter || (statusFilter === 'none' ? !s.status : s.status === statusFilter)))
    const key = (s: Source): string | number => {
      if (sort.col === 'status') return STATUS_ORDER[s.status || '']
      if (sort.col === 'rating') return +(s.rating || 0)
      if (sort.col === 'highlights') return s.highlights
      return (s[sort.col] ?? '').toString().toLowerCase()
    }
    return out.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      // Blanks last whichever way it's sorted.
      if (ka === '' && kb !== '') return 1
      if (kb === '' && ka !== '') return -1
      return (ka < kb ? -1 : ka > kb ? 1 : a.title.localeCompare(b.title)) * sort.dir
    })
  }, [shown, typeFilter, statusFilter, sort])

  const pickFile = () => fileInput.current?.click()
  const onFile = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    setImporting({ name: file.name, text, plan: null, busy: true })
    try {
      const plan = await api.previewImport(text, file.name)
      setImporting({ name: file.name, text, plan, busy: false })
    } catch (e) {
      setImporting({ name: file.name, text, plan: null, busy: false, error: (e as Error).message })
    }
  }
  const runImport = async () => {
    if (!importing) return
    setImporting({ ...importing, busy: true })
    try {
      const done = await run(() => api.runImport(importing.text, importing.name))
      setImporting(null)
      say(done.fresh ? `Imported ${count(done.fresh, 'highlight')} into ${count(done.books.filter((b) => b.fresh).length, 'source')}` : 'Nothing new to import')
      await load()
      onChanged(done.touched ?? [])
    } catch (e) {
      setImporting({ ...importing, busy: false, error: (e as Error).message })
    }
  }

  const empty = sources !== null && sources.length === 0

  return (
    <div className="page brain-page">
      <div className="doc-meta">
        <span>Brain</span>
        {sources && sources.length > 0 && <span className="muted">· {count(sources.length, 'source')}</span>}
        <span className="muted path">{folder}/</span>
      </div>
      <h1 className="doc-title static">Brain</h1>

      <input
        ref={fileInput}
        type="file"
        accept=".txt,.csv,text/plain,text/csv"
        hidden
        aria-label="Highlights file"
        onChange={(e) => {
          onFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {error && <p className="brain-error">{error}</p>}

      {empty && (
        <div className="brain-empty">
          <p>Keep the books, podcasts, videos and articles you learn from, and the lines worth keeping. {helpMod}1 Recall can quote them while you write, with where they came from.</p>
          <div className="brain-empty-actions">
            <button className="btn primary" onClick={() => setAdding(true)}>
              + Add your first source
            </button>
            <button className="btn" onClick={pickFile}>
              Import Kindle highlights
            </button>
          </div>
          <p className="muted brain-empty-note">Kindle’s My Clippings.txt or a Readwise CSV. Read on this computer; nothing is sent anywhere.</p>
        </div>
      )}

      {sources && sources.length > 0 && (
        <>
          <div className="brain-tools">
            <input className="brain-search" type="search" placeholder="Search titles, authors, tags" aria-label="Search the Brain" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="seg seg-text" role="radiogroup" aria-label="View">
              {(['shelf', 'table'] as const).map((v) => (
                <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'is-on' : ''} onClick={() => setView(v)}>
                  {v === 'shelf' ? 'Shelf' : 'Table'}
                </button>
              ))}
            </div>
            <span className="spacer" />
            <button className="btn" onClick={pickFile} title="Kindle’s My Clippings.txt or a Readwise CSV">
              Import highlights
            </button>
            <button className="btn primary" onClick={() => setAdding(true)}>
              + Add source
            </button>
          </div>

          {view === 'shelf' ? (
            <div className="brain-shelf">
              {SOURCE_TYPES.map((t) => {
                const group = shown.filter((s) => s.type === t).sort((a, b) => (b.status === 'reading' ? 1 : 0) - (a.status === 'reading' ? 1 : 0) || a.title.localeCompare(b.title))
                if (!group.length) return null
                return (
                  <section key={t} className="brain-group" aria-label={GROUP_LABELS[t]}>
                    <h2>
                      {GROUP_LABELS[t]} <span className="muted">{group.length}</span>
                    </h2>
                    <ul>
                      {group.map((s) => (
                        <li key={s.path} className={`brain-card${fresh === s.path ? ' is-fresh' : ''}`}>
                          <button className="brain-card-main" onClick={() => onOpenDoc(s.path)} title={s.path}>
                            <span className="brain-card-title">{s.title}</span>
                            {s.author && <span className="brain-card-author">{s.author}</span>}
                            <span className="brain-card-meta">
                              {s.status && <span className={`pill is-${s.status}`}>{STATUS_LABELS[s.status]}</span>}
                              {s.rating && (
                                <span className="rating" aria-label={`Rated ${s.rating} of 5`}>
                                  {'★'.repeat(+s.rating)}
                                </span>
                              )}
                              {s.highlights > 0 && <span className="muted">{count(s.highlights, 'highlight')}</span>}
                            </span>
                          </button>
                          <button className="brain-card-add" title="Add a highlight" aria-label={`Add a highlight to ${s.title}`} onClick={() => setHighlightFor(s)}>
                            + Highlight
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })}
              {!shown.length && <p className="empty">Nothing matches “{query}”.</p>}
            </div>
          ) : (
            <div className="brain-table-wrap">
              <div className="brain-filters">
                <label>
                  Type
                  <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as SourceType | '')} aria-label="Filter by type">
                    <option value="">All</option>
                    {SOURCE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Status
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
                    <option value="">All</option>
                    <option value="want">{STATUS_LABELS.want}</option>
                    <option value="reading">{STATUS_LABELS.reading}</option>
                    <option value="done">{STATUS_LABELS.done}</option>
                    <option value="none">No status</option>
                  </select>
                </label>
                <span className="muted">{count(rows.length, 'source')}</span>
              </div>
              <table className="brain-table">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => (
                      <th key={c.id} aria-sort={sort.col === c.id ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={c.id === 'highlights' || c.id === 'rating' ? 'num' : ''}>
                        <button onClick={() => setSort((s) => ({ col: c.id, dir: s.col === c.id ? (-s.dir as 1 | -1) : c.id === 'highlights' || c.id === 'rating' || c.id === 'finished' ? -1 : 1 }))}>
                          {c.label}
                          <span className="sort-mark" aria-hidden="true">
                            {sort.col === c.id ? (sort.dir === 1 ? '↑' : '↓') : ''}
                          </span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.path} onClick={() => onOpenDoc(s.path)} className={fresh === s.path ? 'is-fresh' : ''}>
                      <td>{TYPE_LABELS[s.type]}</td>
                      <td className="title">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenDoc(s.path)
                          }}
                        >
                          {s.title}
                        </button>
                      </td>
                      <td>{s.author}</td>
                      <td>{s.status && <span className={`pill is-${s.status}`}>{STATUS_LABELS[s.status]}</span>}</td>
                      <td className="num">{s.rating ? '★'.repeat(+s.rating) : ''}</td>
                      <td>{s.finished}</td>
                      <td className="tags">{s.tags}</td>
                      <td className="num">{s.highlights || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length && <p className="empty">No sources match.</p>}
            </div>
          )}
        </>
      )}

      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
        </div>
      )}

      {adding && (
        <AddSource
          onClose={() => setAdding(false)}
          onSaved={async ({ path, existed, touched }) => {
            setAdding(false)
            if (existed) {
              say('Already in your Brain, so it’s opened')
              onOpenDoc(path)
              return
            }
            await load()
            onChanged(touched ?? [])
            setFresh(path)
            say('Added to your Brain')
          }}
        />
      )}

      {highlightFor && (
        <AddHighlight
          source={highlightFor}
          onClose={() => setHighlightFor(null)}
          run={run}
          onAdded={async ({ added, touched }) => {
            setHighlightFor(null)
            say(added ? 'Highlight kept' : 'That highlight is already there')
            if (added) onChanged(touched ?? [])
            await load()
          }}
        />
      )}

      {importing && <ImportDialog state={importing} onCancel={() => setImporting(null)} onImport={runImport} />}
    </div>
  )
}

const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

/** What an import will do, before it does it. */
function ImportDialog({ state, onCancel, onImport }: { state: { name: string; plan: ImportPlan | null; busy: boolean; error?: string }; onCancel: () => void; onImport: () => void }) {
  const { plan } = state
  const books = plan?.books ?? []
  const withNew = books.filter((b) => b.fresh > 0)
  return (
    <Dialog label="Import highlights" onClose={onCancel}>
      <h2>Import highlights</h2>
      <p className="muted brain-file">{state.name}</p>
      {!plan && state.busy && <p>Reading…</p>}
      {state.error && <p className="brain-error">{state.error}</p>}
      {plan && plan.format === null && <p className="brain-error">This doesn’t look like Kindle’s My Clippings.txt or a Readwise CSV export.</p>}
      {plan && plan.format !== null && (
        <>
          <p className="brain-summary">
            {count(withNew.length || books.length, 'book')}, <b>{count(plan.fresh, 'new highlight')}</b>
          </p>
          {plan.skipped > 0 && (
            <p className="brain-warn">
              Couldn’t parse {plan.skipped.toLocaleString()} {plan.skipped === 1 ? 'entry' : 'entries'}. They’re left out.
            </p>
          )}
          {books.length > 0 && (
            <ul className="brain-import-list">
              {books.map((b) => (
                <li key={b.title + b.author}>
                  <span className="t">{b.title}</span>
                  {b.author && <span className="muted"> · {b.author}</span>}
                  <span className="n">{b.fresh ? `${b.fresh} new${b.path ? '' : ' · new note'}` : 'nothing new'}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted brain-empty-note">Highlights already in a note are skipped, and nothing you wrote is changed.</p>
        </>
      )}
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          {plan && plan.fresh === 0 ? 'Close' : 'Cancel'}
        </button>
        {plan && plan.fresh > 0 && (
          <button className="btn primary" disabled={state.busy} onClick={onImport}>
            {state.busy ? 'Importing…' : `Import ${count(plan.fresh, 'highlight')}`}
          </button>
        )}
      </div>
    </Dialog>
  )
}

/** One highlight, typed or pasted, with where it is. */
function AddHighlight({ source, run, onClose, onAdded }: { source: Source; run: Props['run']; onClose: () => void; onAdded: (r: { added: number; touched?: Touched[] }) => void }) {
  const [text, setText] = useState('')
  const [where, setWhere] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timed = source.type === 'video' || source.type === 'podcast'
  const location = formatLocation(where, source.type, source.url)
  const save = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      onAdded(await run(() => api.addHighlight(source.path, text, location)))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog label="Add a highlight" onClose={onClose}>
      <h2>Add a highlight</h2>
      <p className="muted brain-file">
        {source.title}
        {source.author ? ` · ${source.author}` : ''}
      </p>
      <label className="field">
        <span>Highlight</span>
        <textarea
          autoFocus
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
          }}
        />
      </label>
      <label className="field">
        <span>Where {timed ? '(time, like 12:34)' : '(location or page, like 1234 or p. 12)'}</span>
        <input value={where} onChange={(e) => setWhere(e.target.value)} placeholder={timed ? '12:34' : 'loc 1234'} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </label>
      {where.trim() && location && <p className="muted brain-file">Written as “— {location}”</p>}
      {error && <p className="brain-error">{error}</p>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!text.trim() || busy} onClick={save}>
          Add highlight <kbd>⌘↵</kbd>
        </button>
      </div>
    </Dialog>
  )
}
