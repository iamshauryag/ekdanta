import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DocHeader } from './DocHeader.tsx'
import { HEADER_FIELDS, MARGIN_IN, PAPER, STYLES, docOf, formatDate, headerOf, pageCss, runningHead, textBlockPx, type DocStyle, type HeaderField, type Paper } from '../lib/docstyle.ts'
import { pagesFromHeight, parseTarget } from '../lib/targets.ts'
import type { Meta, MetaPatch } from '../lib/frontmatter.ts'
import '../docmode.css'

/** Times, as the style guides ask for, with metric-compatible stand-ins. */
export const PAGE_FONT = '"Times New Roman", Times, "Liberation Serif", "Nimbus Roman", serif'
const PX = 96 // CSS pixels per inch
const MIN_SCALE = 0.6

export interface Profile {
  name: string
  institution: string
}

/** The author and institution, from the piece or else from the writer's profile. */
export const fieldsOf = (meta: Meta, profile: Profile): Partial<Record<HeaderField, string>> => ({
  ...Object.fromEntries(HEADER_FIELDS.map((k) => [k, meta[k]?.trim() ?? ''])),
  author: meta.author?.trim() || profile.name,
  institution: meta.institution?.trim() || profile.institution,
})

interface Props {
  /** Page view is on (and the page, not the Markdown, is showing). */
  on: boolean
  meta: Meta
  title: string
  profile: Profile
  /** How many pages the piece fills, measured: all of them, and those after a title page. Null when page view is off. */
  onPages: (pages: { total: number; body: number } | null) => void
  /** A click on the empty part of the sheet, below the text. */
  onSheetClick: () => void
  onEdit: () => void
  children: React.ReactNode
}

/**
 * Page view: the piece on white sheets on a grey desk, in its style, with its heading block or title page.
 * The same elements wrap the title and the text whether page view is on or not (off, they take no space),
 * so turning it on or off never rebuilds the editor.
 *
 * Pages on screen are an estimate: guide lines mark where each page's text block would end, and lines
 * can sit across them. Print (and Save as PDF) lays out the real pages.
 */
export function DocumentMode({ on, meta, title, profile, onPages, onSheetClick, onEdit, children }: Props) {
  const d = docOf(meta)
  const style: DocStyle = d.style ?? 'none'
  const paper = PAPER[d.paper]
  const header = on ? headerOf(style, fieldsOf(meta, profile), title) : null
  const titlePage = header?.type === 'title-page'
  const head = runningHead(style, fieldsOf(meta, profile).author)

  const box = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const scaler = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const [contentHeight, setContentHeight] = useState(0)

  useLayoutEffect(() => {
    if (!on) return
    const ro = new ResizeObserver(() => {
      setWidth(box.current?.clientWidth ?? 0)
      setHeight(scaler.current?.offsetHeight ?? 0)
      setContentHeight(content.current?.offsetHeight ?? 0)
    })
    for (const el of [box.current, scaler.current, content.current]) if (el) ro.observe(el)
    return () => ro.disconnect()
  }, [on])

  const perPage = textBlockPx(d.paper)
  const bodyPages = on ? pagesFromHeight(contentHeight, perPage) : 0
  const total = on ? bodyPages + (titlePage ? 1 : 0) : null
  useEffect(() => onPages(total === null ? null : { total, body: bodyPages }), [total, bodyPages, onPages])

  // A narrow window shows the whole sheet smaller; it never reflows the lines. Below MIN_SCALE the text
  // would be too small to read, so the desk scrolls sideways instead.
  const sheetPx = paper.widthIn * PX
  const scale = on && width ? Math.max(MIN_SCALE, Math.min(1, (width - 32) / sheetPx)) : 1
  const vars = on ? ({ '--sheet-w': paper.width, '--sheet-h': paper.height, '--page-font': PAGE_FONT } as React.CSSProperties) : undefined

  return (
    <div ref={box} className={`dm${on ? ' is-on' : ''}`} data-style={on ? style : undefined} data-paper={on ? d.paper : undefined} style={vars}>
      {on && <style>{pageCss(style, d.paper, fieldsOf(meta, profile).author, PAGE_FONT)}</style>}
      <div className="dm-fit" style={on ? { width: sheetPx * scale, height: height * scale } : undefined}>
        <div ref={scaler} className="dm-scaler" style={on && scale < 1 ? { transform: `scale(${scale})` } : undefined}>
          {titlePage && (
            <section className="dm-sheet dm-titlepage" aria-label="Title page">
              {head?.onFirst && <div className="dm-runhead">{head.prefix}1</div>}
              <DocHeader header={header} onEdit={onEdit} />
            </section>
          )}
          <div
            className="dm-sheet dm-main"
            style={on ? { minHeight: 2 * MARGIN_IN * PX + bodyPages * perPage } : undefined}
            onMouseDown={(e) => {
              if (on && (e.target === e.currentTarget || e.target === content.current)) {
                e.preventDefault()
                onSheetClick()
              }
            }}
          >
            {on && !titlePage && head?.onFirst && <div className="dm-runhead">{head.prefix}1</div>}
            {on &&
              Array.from({ length: bodyPages - 1 }, (_, i) => (
                <div key={i} className="dm-guide" style={{ top: MARGIN_IN * PX + (i + 1) * perPage }} aria-hidden="true">
                  <span>{i + 2 + (titlePage ? 1 : 0)}</span>
                </div>
              ))}
            <div ref={content} className="dm-content">
              {header?.type === 'block' && <DocHeader header={header} onEdit={onEdit} />}
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- The Document popover ---------------------------------------------------------------------

interface PanelProps {
  meta: Meta
  profile: Profile
  defaultStyle: DocStyle
  setMeta: (patch: MetaPatch) => void
  onClose: () => void
}

const FIELD_LABELS: Record<HeaderField, string> = { author: 'Author', instructor: 'Instructor', course: 'Course', institution: 'Institution', date: 'Date' }
/** Which header fields each style shows. */
const FIELDS_FOR: Record<DocStyle, HeaderField[]> = {
  mla: ['author', 'instructor', 'course', 'date'],
  apa: ['author', 'institution', 'course', 'instructor', 'date'],
  chicago: ['author', 'course', 'instructor', 'date'],
  none: [],
}

/** Document layout: page view, style, paper, the header's fields, a length target, a due date, and print. */
export function DocumentPanel({ meta, profile, defaultStyle, setMeta, onClose }: PanelProps) {
  const d = docOf(meta)
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  // Focus goes into the popover once, when it opens; saving a field must never move it.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], [role="switch"]')?.focus()
  }, [])
  useEffect(() => {
    const onClose = () => close.current()
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!ref.current?.contains(t) && !t.closest('.doc-btn')) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement).closest('input') && onClose()
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [])

  const style = d.style
  const pick = (s: DocStyle) => setMeta(d.page ? { style: s } : { style: s, layout: 'page' })
  // Leaving page view changes only the layout key; the style and fields stay for next time.
  const flip = () => setMeta(d.page ? { layout: null } : style ? { layout: 'page' } : { layout: 'page', style: defaultStyle })
  const set = (key: string, value: string) => {
    const v = value.trim()
    if (v !== (meta[key]?.trim() ?? '')) setMeta({ [key]: v || null })
  }
  const target = parseTarget(meta.target)

  return (
    <div className="dm-panel" role="dialog" aria-label="Document layout" ref={ref}>
      <div className="dm-row">
        <span className="dm-label">Page view</span>
        <button role="switch" aria-checked={d.page} aria-label="Page view" className={`switch${d.page ? ' is-on' : ''}`} onClick={flip} />
      </div>
      <div className="dm-row">
        <span className="dm-label">Style</span>
        <div className="seg seg-text" role="radiogroup" aria-label="Style">
          {STYLES.map((s) => (
            <button key={s.id} role="radio" aria-checked={style === s.id} className={style === s.id ? 'is-on' : ''} title={s.note} onClick={() => pick(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="dm-row">
        <span className="dm-label">Paper</span>
        <div className="seg seg-text" role="radiogroup" aria-label="Paper">
          {(Object.keys(PAPER) as Paper[]).map((p) => (
            <button key={p} role="radio" aria-checked={d.paper === p} className={d.paper === p ? 'is-on' : ''} onClick={() => setMeta({ paper: p === 'letter' ? null : p })}>
              {PAPER[p].label}
            </button>
          ))}
        </div>
      </div>

      {style && FIELDS_FOR[style].length > 0 && (
        <div className="dm-fields" role="group" aria-label={style === 'mla' ? 'Heading' : 'Title page'}>
          <div className="dm-legend">{style === 'mla' ? 'Heading' : 'Title page'}</div>
          {FIELDS_FOR[style].map((k) => {
            const fromProfile = k === 'author' ? profile.name : k === 'institution' ? profile.institution : ''
            return (
              <label key={k} className="dm-field">
                <span>{FIELD_LABELS[k]}</span>
                <Field
                  value={meta[k] ?? ''}
                  label={FIELD_LABELS[k]}
                  placeholder={k === 'date' ? `Today: ${formatDate(undefined, style)}` : fromProfile || (k === 'author' ? 'Your name' : '')}
                  onCommit={(v) => set(k, v)}
                />
                {fromProfile && !meta[k]?.trim() && <small className="dm-from">from your profile</small>}
              </label>
            )
          })}
        </div>
      )}

      <div className="dm-fields">
        <label className="dm-field">
          <span>Target</span>
          <Field value={meta.target ?? ''} label="Target" placeholder="1500, 1500–2000, ≤750, 5 pages, 4000 characters" onCommit={(v) => set('target', v)} />
          {target === 'invalid' && <small className="dm-bad">Not understood. Try 1500, 1500-2000, &lt;=750, 5 pages or 4000 characters</small>}
        </label>
        <label className="dm-field">
          <span>Due</span>
          <input type="date" className="dm-input" value={/^\d{4}-\d{2}-\d{2}$/.test(meta.due ?? '') ? meta.due : ''} onChange={(e) => set('due', e.target.value)} aria-label="Due date" />
        </label>
      </div>

      <button
        className="btn dm-print"
        onClick={() => {
          onClose()
          // After the popover has gone, so it isn't in the print.
          window.setTimeout(() => window.print(), 50)
        }}
      >
        Print / Save as PDF
      </button>
    </div>
  )
}

/**
 * A text field that saves when you leave it, press Return, or close the popover while typing, and puts
 * back what was there on Escape. A click outside closes the popover before the field could blur, so what
 * was typed is saved as the field goes away.
 */
function Field({ value, placeholder, label, onCommit }: { value: string; placeholder: string; label: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const latest = useRef({ draft, value, onCommit })
  latest.current = { draft, value, onCommit }
  const commit = () => {
    const { draft, value, onCommit } = latest.current
    if (draft !== value) onCommit(draft)
  }
  useEffect(() => commit, [])
  return (
    <input
      className="dm-input"
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          e.preventDefault()
          // Put the old value back before leaving, so neither the blur nor closing saves the draft.
          latest.current.draft = value
          setDraft(value)
          const el = e.currentTarget
          window.setTimeout(() => el.blur())
        }
      }}
    />
  )
}
