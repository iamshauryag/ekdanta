import { useEffect, useRef, useState } from 'react'
import { listOf, type FrontMatter, type MetaPatch } from '../lib/frontmatter.ts'
import { cleanTag, metaTags, type TagCount } from '../lib/tags.ts'
import { modifiedLabel, modifiedStamp } from '../lib/modified.ts'

interface Props {
  fm: Pick<FrontMatter, 'meta' | 'lists' | 'readonly' | 'problem' | 'raw'>
  open: boolean
  onOpen: (open: boolean) => void
  onPatch: (patch: MetaPatch) => void
  /** Every tag in the vault, for suggestions. */
  vaultTags: TagCount[]
  /** When the file last changed on disk (its mtime), shown as a read-only property. */
  modified?: number
}

const STATUSES = ['draft', 'ready', 'published']
// The title and kind have their own places on the page; the star has its own button.
const OWNED = new Set(['title', 'platform', 'exemplar'])
const LISTS = new Set(['tags', 'aliases', 'cssclasses'])
const DATES = new Set(['created', 'published', 'updated', 'date', 'due'])
// The same keys lib/frontmatter.ts reads: letters in any script, digits, _ . - and single spaces.
const KEY = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_.-]*(?: [\p{L}\p{N}\p{M}_.-]+)*$/u

const today = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** The document's properties: one quiet line under the title, a table when opened. */
export function Properties({ fm, open, onOpen, onPatch, vaultTags, modified }: Props) {
  const status = fm.meta.status
  // Read as the vault's counts read it: `tags: craft essays` is two tags.
  const tags = metaTags(fm)
  const keys = Object.keys(fm.meta).filter((k) => !OWNED.has(k) && k !== 'status')
  const others = keys.filter((k) => k !== 'tags').length
  const summary = fm.readonly ? ["can't be edited here"] : [status || '', tags.length ? `${tags.length} ${tags.length === 1 ? 'tag' : 'tags'}` : '', others ? `${others} more` : ''].filter(Boolean)
  const [adding, setAdding] = useState(false)

  return (
    <section className={`props${open ? ' is-open' : ''}`} aria-label="Properties">
      <button className="props-toggle" aria-expanded={open} onClick={() => onOpen(!open)} title={open ? 'Hide properties' : 'Show properties'}>
        <svg className="props-caret" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4.5 3 7.5 6l-3 3" />
        </svg>
        Properties
        {summary.map((s) => (
          <span key={s}> · {s}</span>
        ))}
      </button>
      {open && fm.readonly && (
        <div className="props-readonly" role="note">
          <p>
            <b>Front matter can't be edited here.</b> {fm.problem} Ekdanta leaves it exactly as it is.
          </p>
          <pre>{fm.raw}</pre>
        </div>
      )}
      {open && !fm.readonly && (
        <div className="props-table" role="table">
          <Row name="status">
            <select
              className="props-select"
              aria-label="Status"
              value={status ?? ''}
              onChange={(e) => onPatch(e.target.value === 'published' ? { status: 'published', published: today() } : { status: e.target.value || null })}
            >
              <option value="">None</option>
              {(status && !STATUSES.includes(status) ? [...STATUSES, status] : STATUSES).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Row>
          <Row name="tags">
            <Chips label="Tags" values={tags} onChange={(v) => onPatch({ tags: v })} clean={cleanTag} suggestions={vaultTags} prefix="#" />
          </Row>
          {keys
            .filter((k) => k !== 'tags')
            .map((k) => (
              <Row key={k} name={k} onRemove={() => onPatch({ [k]: null })}>
                {LISTS.has(k) || k in fm.lists ? (
                  <Chips label={k} values={listOf(fm, k)} onChange={(v) => onPatch({ [k]: v.length ? v : null })} clean={(s) => s.trim()} />
                ) : DATES.has(k) && /^(\d{4}-\d{2}-\d{2})?$/.test(fm.meta[k]) ? (
                  <input type="date" className="props-input" aria-label={k} value={fm.meta[k]} onChange={(e) => onPatch({ [k]: e.target.value })} />
                ) : (
                  <TextValue label={k} value={fm.meta[k]} onCommit={(v) => onPatch({ [k]: v })} />
                )}
              </Row>
            ))}
          {/* From the file itself, so it can't be edited or removed here. A `modified` key the writer keeps (an Obsidian plugin's, say) shows instead. */}
          {modified !== undefined && !('modified' in fm.meta) && (
            <Row name="modified">
              <span className="props-derived" title={`${modifiedStamp(modified)}, from the file`}>
                {modifiedLabel(modified)}
              </span>
            </Row>
          )}
          {adding ? (
            <NewKey
              taken={(k) => k in fm.meta || k === 'status' || k === 'tags'}
              onAdd={(k) => {
                setAdding(false)
                if (k) onPatch({ [k]: DATES.has(k) && k !== 'due' ? today() : '' })
              }}
            />
          ) : (
            <button className="props-add" onClick={() => setAdding(true)}>
              + Add property
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function Row({ name, children, onRemove }: { name: string; children: React.ReactNode; onRemove?: () => void }) {
  return (
    <div className="props-row" role="row">
      <span className="props-key" role="rowheader">
        {name}
      </span>
      <span className="props-value" role="cell">
        {children}
      </span>
      {onRemove && (
        <button className="props-remove" title={`Remove ${name}`} aria-label={`Remove ${name}`} onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  )
}

/** A text value, written when the field is left or Return is pressed. Escape puts it back. */
function TextValue({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <input
      className="props-input"
      aria-label={label}
      value={text}
      placeholder="Empty"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          setText(value)
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
        }
      }}
    />
  )
}

/** The name of a new property. Return adds it, Escape or an empty name cancels. */
function NewKey({ taken, onAdd }: { taken: (k: string) => boolean; onAdd: (k: string | null) => void }) {
  const [name, setName] = useState('')
  const key = name.trim()
  const problem = !key ? '' : !KEY.test(key) ? 'Letters, digits, - and _ only' : taken(key) || OWNED.has(key) ? 'Already here' : ''
  return (
    <div className="props-row props-new">
      <input
        className="props-input"
        autoFocus
        aria-label="New property name"
        placeholder="Property name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => onAdd(key && !problem ? key : null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !problem) onAdd(key || null)
          else if (e.key === 'Escape') onAdd(null)
        }}
      />
      {problem && <span className="props-hint">{problem}</span>}
    </div>
  )
}

/** A list of values as chips. Return or a comma adds; Backspace in an empty field removes the last. */
export function Chips({
  label,
  values,
  onChange,
  clean,
  suggestions,
  prefix = '',
  autoFocus,
}: {
  label: string
  values: string[]
  onChange: (v: string[]) => void
  clean: (s: string) => string
  suggestions?: TagCount[]
  prefix?: string
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  const [pick, setPick] = useState(-1) // the highlighted suggestion; -1 for none
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // Escape leaves the field without adding what was typed. The blur it causes runs before the cleared
  // text is rendered, so it reads this instead of the (still full) text.
  const dropTyped = useRef(false)
  const has = (v: string) => values.some((x) => x.toLowerCase() === v.toLowerCase())
  const q = clean(text).toLowerCase()
  const options = focused && suggestions ? suggestions.filter((s) => !has(s.tag) && (!q || s.tag.toLowerCase().includes(q))).slice(0, 8) : []

  const add = (raw: string) => {
    const items = raw.split(',').map(clean).filter(Boolean)
    const next = [...values]
    for (const v of items) if (!next.some((x) => x.toLowerCase() === v.toLowerCase())) next.push(v)
    setText('')
    setPick(-1)
    if (next.length !== values.length) onChange(next)
  }

  return (
    <span className="prop-chips" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), input.current?.focus())}>
      {values.map((v) => (
        <span key={v} className="prop-chip">
          {prefix}
          {v}
          <button
            className="prop-chip-x"
            aria-label={`Remove ${prefix}${v}`}
            title={`Remove ${prefix}${v}`}
            onClick={() => {
              onChange(values.filter((x) => x !== v))
              input.current?.focus() // the button goes with its chip; keep the writer in the field
            }}
          >
            ×
          </button>
        </span>
      ))}
      <span className="prop-chips-field">
        <input
          ref={input}
          autoFocus={autoFocus}
          className="prop-chips-input"
          aria-label={`Add to ${label}`}
          placeholder={values.length ? '' : 'Add…'}
          value={text}
          role="combobox"
          aria-expanded={options.length > 0}
          aria-autocomplete="list"
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            if (dropTyped.current) {
              dropTyped.current = false
              setText('')
              setPick(-1)
            } else if (text.trim()) add(text)
          }}
          onChange={(e) => {
            const v = e.target.value
            if (v.includes(',')) add(v)
            else {
              setText(v)
              setPick(-1)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              // A highlighted suggestion, or what was typed (in the vault's casing if the tag exists).
              if (options[pick]) add(options[pick].tag)
              else if (text.trim()) add(suggestions?.find((o) => o.tag.toLowerCase() === q)?.tag ?? text)
            } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1))
            else if (e.key === 'ArrowDown' && options.length) {
              e.preventDefault()
              setPick((p) => (p + 1) % options.length)
            } else if (e.key === 'ArrowUp' && options.length) {
              e.preventDefault()
              setPick((p) => (p <= 0 ? options.length - 1 : p - 1))
            } else if (e.key === 'Escape') {
              dropTyped.current = true
              e.currentTarget.blur()
            }
          }}
        />
        {options.length > 0 && (
          <span className="prop-chips-menu" role="listbox">
            {options.map((o, i) => (
              <button
                key={o.tag}
                role="option"
                tabIndex={-1} // picked with ↑↓ and Return; Tab moves on to the next field
                aria-selected={i === pick}
                className={i === pick ? 'is-on' : ''}
                onMouseDown={(e) => {
                  e.preventDefault()
                  add(o.tag)
                }}
              >
                {prefix}
                {o.tag}
                <span className="muted">{o.count}</span>
              </button>
            ))}
          </span>
        )}
      </span>
    </span>
  )
}
