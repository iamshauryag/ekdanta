import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Settings as S, type Status } from '../lib/api.ts'
import { searchRows } from '../lib/appearance.ts'
import { ROWS, RowName, Switch, TABS, tabLabel, type RowCtx, type SettingRow, type Tab } from './settingsRows.tsx'

interface Props {
  settings: S
  status: Status | null
  onChange: (patch: Partial<S>) => void
  onClose: () => void
  onRenameKindFolder?: (id: string) => Promise<void>
  /** Every folder in the vault, for the folder pickers. */
  folders: string[]
  /** Why the chosen CSS snippet isn't applied, if it isn't. */
  snippetNote: string | null
}

// Reopening Settings returns to the tab you left.
let lastTab: Tab = 'writing'

export function Settings({ settings: s, status, onChange, onClose, onRenameKindFolder, folders, snippetNote }: Props) {
  const sheet = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [index, setIndex] = useState<string | null>(null)
  const [snippets, setSnippets] = useState<string[] | null>(null)
  const [tab, setTabState] = useState<Tab>(lastTab)
  const [query, setQuery] = useState('')
  // Advanced rows a search led to stay in view until you move to another tab.
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [flash, setFlash] = useState<string | null>(null)
  const setTab = (t: Tab) => {
    lastTab = t
    setTabState(t)
  }
  const pickTab = (t: Tab) => {
    if (t !== tab) setRevealed(new Set())
    setTab(t)
  }

  const tabsRef = useRef<HTMLDivElement>(null)
  // Arrow keys move between tabs, as in any tab list.
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab)
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null
    if (to === null) return
    e.preventDefault()
    const next = TABS[(to + TABS.length) % TABS.length].id
    pickTab(next)
    tabsRef.current?.querySelector<HTMLElement>(`#settings-tab-${next}`)?.focus()
  }
  // The sheet takes the keyboard once, when it opens. Focusing it again on a later render would pull
  // the keyboard off the slider or switch being used, so this effect must not depend on anything.
  useEffect(() => {
    sheet.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    api
      .snippets()
      .then(setSnippets)
      .catch(() => setSnippets([]))
  }, [])

  const rebuild = async () => {
    setIndex('Rebuilding…')
    const r = await api.reindex()
    setIndex(`${r.paragraphs} paragraphs from ${r.files} documents`)
  }

  const ctx: RowCtx = { s, status, onChange, folders, snippets, snippetNote, index, rebuild, onRenameFolder: onRenameKindFolder }
  const offered = ROWS.filter((r) => !r.when || r.when(ctx))
  const hits = useMemo(() => searchRows(offered, tabLabel, query), [offered.map((r) => r.id).join(), query]) // eslint-disable-line react-hooks/exhaustive-deps
  const searching = query.trim().length > 0
  const hitTabs = new Set(hits.map((h) => h.tab))

  // Searching jumps to the tab of the best match, unless the tab you're on has one too.
  useEffect(() => {
    if (hits.length && !hitTabs.has(tab)) setTab(hits[0].tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits])

  // Keep the open tab in view where the tab strip scrolls (on a phone).
  useEffect(() => {
    tabsRef.current?.querySelector('.is-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])

  // Bring a highlighted row into view.
  const firstHit = searching ? hits.find((h) => h.tab === tab)?.id : flash
  useEffect(() => {
    if (!firstHit) return
    body.current?.querySelector(`[data-row="${firstHit}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [firstHit, tab])
  useEffect(() => {
    if (!flash) return
    const t = window.setTimeout(() => setFlash(null), 1600)
    return () => window.clearTimeout(t)
  }, [flash])

  /** Leave the search where it led: its rows stay revealed in their tab, and the first is highlighted. */
  const choose = () => {
    const here = hits.filter((h) => h.tab === tab)
    if (here.length) {
      setRevealed(new Set(here.filter((h) => h.advanced).map((h) => h.id)))
      setFlash(here[0].id)
    }
    setQuery('')
  }
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query) {
      e.stopPropagation() // clears the search; a second Esc closes Settings
      choose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose()
    }
  }

  const shown = (r: SettingRow) => !r.advanced || s.showAdvanced || revealed.has(r.id) || !!r.showAnyway?.(ctx)
  const visible = (r: SettingRow) => r.tab === tab && (searching ? hits.includes(r) : shown(r))
  const rows = offered.filter(visible)
  const hiddenHere = !searching && !s.showAdvanced ? offered.filter((r) => r.tab === tab && !shown(r)).length : 0

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label="Settings" tabIndex={-1} ref={sheet}>
        <header className="sheet-head">
          <h2>Settings</h2>
          <input
            ref={searchRef}
            className="input sheet-search"
            type="search"
            placeholder="Search settings"
            aria-label="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="sheet-tabs" role="tablist" aria-label="Settings sections" ref={tabsRef} onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`settings-tab-${t.id}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls="settings-panel"
              tabIndex={tab === t.id ? 0 : -1}
              className={`sheet-tab${tab === t.id ? ' is-on' : ''}${searching && !hitTabs.has(t.id) ? ' is-dim' : ''}`}
              onClick={() => pickTab(t.id)}
            >
              {t.label}
              {searching && hitTabs.has(t.id) && <span className="tab-count">{hits.filter((h) => h.tab === t.id).length}</span>}
            </button>
          ))}
        </div>

        <div className="sheet-body" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} ref={body}>
          {searching && !hits.length ? (
            <p className="sheet-empty">
              Nothing matches “{query.trim()}”. <span className="muted">Esc clears the search.</span>
            </p>
          ) : searching && !rows.length ? (
            <p className="sheet-empty">Nothing on this tab matches “{query.trim()}”.</p>
          ) : (
            <section>
              {rows.map((r) => {
                const cls = `${searching ? ' is-hit' : ''}${flash === r.id ? ' is-flash' : ''}`
                const tag = r.advanced && !s.showAdvanced ? <em className="adv-tag">Advanced</em> : null
                return r.full ? (
                  <div key={r.id} className={`row-full${cls}`} data-row={r.id}>
                    {tag}
                    <RowName.Provider value={r.label}>{r.render(ctx)}</RowName.Provider>
                  </div>
                ) : (
                  <div key={r.id} className={`row${cls}`} data-row={r.id}>
                    <div className="row-label">
                      <span>
                        {r.label}
                        {tag}
                      </span>
                      {r.hint && hintOf(r, ctx)}
                    </div>
                    <div className="row-control">
                      <RowName.Provider value={r.label}>{r.render(ctx)}</RowName.Provider>
                    </div>
                  </div>
                )
              })}
              {hiddenHere > 0 && (
                <p className="sheet-more">
                  {hiddenHere} more {hiddenHere === 1 ? 'setting' : 'settings'} under Show advanced settings.
                </p>
              )}
            </section>
          )}
        </div>

        <footer className="sheet-foot">
          <label className="sheet-advanced">
            <Switch on={s.showAdvanced} label="Show advanced settings" onFlip={(showAdvanced) => onChange({ showAdvanced })} />
            <span>Show advanced settings</span>
          </label>
          <small>Hidden settings keep their values.</small>
        </footer>
      </div>
    </div>
  )
}

function hintOf(r: SettingRow, ctx: RowCtx) {
  const h = r.hint?.(ctx)
  return h ? <small>{h}</small> : null
}
