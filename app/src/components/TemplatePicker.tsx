import { useEffect, useMemo, useRef, useState } from 'react'
import type { Kind } from '../lib/kinds.ts'
import { fuzzyScore, groupTemplates, type TemplateInfo } from '../lib/templates.ts'

interface PickerProps {
  /** "New from template", "Start from a template"… */
  title: string
  templates: TemplateInfo[]
  kinds: Kind[]
  onPick: (t: TemplateInfo) => void
  onClose: () => void
  /** Write the starter set into templates/; resolves with how many were added. */
  onSeed: () => Promise<number>
}

/** Choose a template: type to filter, ↑↓ to move, ↵ to choose. With none in the vault, offers the starter set. */
export function TemplatePicker({ title, templates, kinds, onPick, onClose, onSeed }: PickerProps) {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [seeding, setSeeding] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(() => {
    const q = query.trim()
    if (!q) return groupTemplates(templates, kinds)
    // Filtered: best matches first, in one list.
    const kindName = (t: TemplateInfo) => kinds.find((k) => k.id === t.kind)?.name ?? ''
    const scored = templates.map((t) => ({ t, score: Math.max(fuzzyScore(q, t.name), fuzzyScore(q, kindName(t)) / 2) })).filter((x) => x.score > 0)
    scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    return scored.length ? [{ label: '', items: scored.map((x) => x.t) }] : []
  }, [query, templates, kinds])
  const flat = groups.flatMap((g) => g.items)

  useEffect(() => setSel(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab') {
      // A dialog keeps the keyboard: Tab moves between its own controls and never out to the page
      // behind it, so Esc still closes it however far the writer has tabbed.
      e.preventDefault()
      const stops = [...(boxRef.current?.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])') ?? [])].filter((el) => !el.hasAttribute('disabled'))
      if (!stops.length) return
      const i = stops.indexOf(document.activeElement as HTMLElement)
      stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length) setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      // Tabbed onto a button inside the picker ("Add starter templates"): ↵ presses that button.
      if ((document.activeElement as HTMLElement | null)?.tagName === 'BUTTON') return
      e.preventDefault()
      if (flat[sel]) onPick(flat[sel])
    }
  }

  const seed = async () => {
    setSeeding(true)
    try {
      await onSeed()
    } finally {
      setSeeding(false)
    }
  }

  let i = -1
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tpl-picker" role="dialog" aria-modal="true" aria-label={title} ref={boxRef} onKeyDown={onKey}>
        <input
          className="tpl-filter"
          autoFocus
          value={query}
          placeholder={`${title}: type to filter`}
          aria-label="Filter templates"
          // A combobox over the list below: the reader hears the highlighted template as ↑↓ move it.
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="tpl-list"
          aria-activedescendant={flat[sel] ? `tpl-option-${sel}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="tpl-list" id="tpl-list" role="listbox" aria-label={title} ref={listRef}>
          {!templates.length ? (
            <div className="tpl-empty">
              <p>No templates yet. Templates are Markdown files in templates/, with prompts that give a piece its structure.</p>
              <button className="btn primary" onClick={seed} disabled={seeding}>
                {seeding ? 'Adding…' : 'Add starter templates'}
              </button>
            </div>
          ) : !flat.length ? (
            <div className="tpl-empty">No template by that name</div>
          ) : (
            groups.map((g) => (
              <div key={g.label || 'matches'}>
                {g.label && <div className="tpl-group">{g.label}</div>}
                {g.items.map((t) => {
                  i++
                  const k = i
                  return (
                    <button
                      key={t.path}
                      id={`tpl-option-${k}`}
                      role="option"
                      aria-selected={k === sel}
                      className={`tpl-item${k === sel ? ' is-sel' : ''}`}
                      tabIndex={-1}
                      onMouseMove={() => k !== sel && setSel(k)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onPick(t)}
                    >
                      <span>{t.name}</span>
                      <span className="tpl-path">{t.path}</span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

interface StartFromProps {
  templates: TemplateInfo[]
  /** The new draft's kind. */
  platform: string
  /** The kind's default template, pre-highlighted so ↵ applies it. */
  preferred?: string
  onApply: (t: TemplateInfo) => void
  onAll: () => void
}

/**
 * Under a new, empty draft's kinds: Start from Blank, a template for this kind, or any template.
 * The kind's default is highlighted, and ↵ (in the title or the empty page) applies it; Esc keeps it blank.
 */
export function StartFrom({ templates, platform, preferred, onApply, onAll }: StartFromProps) {
  const mine = templates.filter((t) => t.kind === platform)
  const fallback = templates.find((t) => t.path === preferred) ? preferred! : null
  const [choice, setChoice] = useState<{ platform: string; path: string | null } | null>(null)
  const lit = choice && choice.platform === platform ? choice.path : fallback
  const litTemplate = templates.find((t) => t.path === lit)
  // A default for another kind still shows here, so ↵ visibly applies what's highlighted.
  const shown = litTemplate && !mine.includes(litTemplate) ? [litTemplate, ...mine] : mine

  const latest = useRef({ litTemplate, onApply, platform })
  latest.current = { litTemplate, onApply, platform }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (!target?.closest?.('.doc-title, .editor .pm')) return
      const { litTemplate: t } = latest.current
      if (!t || e.isComposing) return
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        latest.current.onApply(t)
      } else if (e.key === 'Escape') setChoice({ platform: latest.current.platform, path: null })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="start-from" aria-label="Start from">
      <span className="muted">Start from</span>
      <button className={!litTemplate ? 'is-on' : ''} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => setChoice({ platform, path: null })}>
        Blank
      </button>
      {shown.map((t) => (
        <button
          key={t.path}
          className={t === litTemplate ? 'is-on' : ''}
          title={t === litTemplate ? '↵ to start from this template, Esc for a blank page' : undefined}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onApply(t)}
        >
          {t.name}
          {t === litTemplate && <kbd>↵</kbd>}
        </button>
      ))}
      <button tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={onAll}>
        All templates…
      </button>
    </div>
  )
}
