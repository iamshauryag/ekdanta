// The Import sheet: files chosen, dropped, or waiting in the vault's _inbox/ are converted to Markdown
// and listed for review. Nothing reaches the vault until the writer imports the rows they want.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MarkdownIt from 'markdown-it'
import { api, type ImportItem } from '../lib/api.ts'
import { kinds } from '../lib/kinds.ts'
import { splitFrontMatter } from '../lib/frontmatter.ts'
import { cleanTag, type TagCount } from '../lib/tags.ts'

/** Over this, the writer is asked before a file is sent. */
const BIG = 50 * 1024 * 1024

interface Props {
  /** Files to start with (dropped on the sidebar). */
  files?: File[]
  /** Open the file chooser straight away. */
  pick?: boolean
  /** Folders already in the vault, offered as destinations. */
  folders: string[]
  onClose: (batch: string | null, imported: string[]) => void
  onImported: (paths: string[]) => void
  onUndone: (result: { removed: string[]; trashed: string[]; missing: string[] }) => void
  /** Progress for the status bar ("Importing 3/12…"), or null when idle. */
  onProgress: (text: string | null) => void
}

interface Choice {
  checked: boolean
  platform: string
  folder: string
  /** Labels for the note's tags. */
  tags: string[]
  /** Still being converted: its kind and folder aren't known yet. */
  waiting: boolean
}

const md = new MarkdownIt({ html: false, linkify: true })
// Pictures aren't in the vault yet, so the preview names them instead.
md.renderer.rules.image = (tokens, i) => {
  const t = tokens[i]
  const src = t.attrGet('src') ?? ''
  return src.startsWith('ekdanta-media:')
    ? `<span class="import-pic">Picture: ${md.utils.escapeHtml(t.content || src.slice(14))}</span>`
    : `<img src="${md.utils.escapeHtml(src)}" alt="${md.utils.escapeHtml(t.content)}">`
}

const TYPE_LABEL: Record<ImportItem['type'], string> = { docx: 'DOCX', doc: 'DOC', pdf: 'PDF', html: 'HTML', text: 'TXT', markdown: 'MD', rtf: 'RTF', csv: 'CSV', other: 'FILE' }
const STATUS_LABEL: Record<ImportItem['status'], string> = {
  pending: 'Converting…',
  converted: 'Converted',
  review: 'Needs review',
  failed: 'Failed',
  duplicate: 'Already imported',
  unsupported: 'Unsupported type',
}
const converterLabel = (c?: string) => (c === 'pandoc' ? 'via Pandoc' : c === 'textutil' ? 'via macOS' : c ? 'built-in' : '')
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 10 * 1024 * 1024 ? 0 : 1)} MB`
const DEFAULT_FOLDER = 'imported'
const defaultFolder = (platform: string) => kinds().find((k) => k.id === platform)?.folder ?? DEFAULT_FOLDER
const importable = (it: ImportItem) => it.status !== 'failed' && it.status !== 'pending' && !it.imported

export function ImportSheet({ files, pick, folders, onClose, onImported, onUndone, onProgress }: Props) {
  const [batch, setBatch] = useState<string | null>(null)
  const [pandoc, setPandoc] = useState(false)
  const [items, setItems] = useState<ImportItem[]>([])
  const [uploading, setUploading] = useState<{ key: string; name: string; size: number }[]>([])
  const [big, setBig] = useState<File[]>([])
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<string>('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  // Labels for every file: shown only when the writer asks for them.
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [batchTags, setBatchTags] = useState<string[]>([])
  const batchTagsRef = useRef<string[]>([])
  const [vaultTags, setVaultTags] = useState<TagCount[]>([])
  const input = useRef<HTMLInputElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  // Work on files happens one at a time, in the order they came.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const batchRef = useRef<Promise<string | null> | null>(null)

  const progress = useCallback(
    (text: string | null) => {
      setBusy(text)
      onProgress(text)
    },
    [onProgress],
  )

  /** A row came back from the server: show it, and choose for it if it's new. */
  const upsert = useCallback((it: ImportItem) => {
    setItems((list) => (list.some((o) => o.id === it.id) ? list.map((o) => (o.id === it.id ? it : o)) : [...list, it]))
    setChoices((c) => {
      const prev = c[it.id]
      if (it.imported) return { ...c, [it.id]: { ...(prev ?? { platform: it.platform ?? '', folder: it.folder, tags: it.tags ?? [], waiting: false }), checked: false } }
      // The writer's choices stand; a row that has only now been converted takes its own defaults.
      if (prev && !prev.waiting) return c
      const waiting = it.status === 'pending'
      return {
        ...c,
        [it.id]: { checked: !waiting && it.status !== 'failed' && it.status !== 'duplicate', platform: it.platform ?? '', folder: it.folder, tags: prev?.tags ?? [...batchTagsRef.current], waiting },
      }
    })
    setSelected((s) => s ?? it.id)
  }, [])

  // Start the batch: it brings whatever is in _inbox/ with it.
  const ensureBatch = useCallback(() => {
    batchRef.current ??= api
      .importBatch()
      .then(async (b) => {
        setBatch(b.batch)
        setPandoc(b.pandoc)
        b.items.forEach(upsert)
        const waiting = b.items.filter((it) => it.status === 'pending')
        if (waiting.length) {
          queue.current = queue.current.then(async () => {
            for (const [n, it] of waiting.entries()) {
              progress(`Importing ${n + 1}/${waiting.length}…`)
              await api.importConvert(b.batch, it.id).then(upsert, (e) => setError((e as Error).message))
            }
            progress(null)
          })
        }
        return b.batch
      })
      .catch((e) => {
        setError((e as Error).message)
        return null
      })
    return batchRef.current
  }, [upsert, progress])

  const send = useCallback(
    (list: File[]) => {
      if (!list.length) return
      const rows = list.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, size: f.size, file: f }))
      setUploading((u) => [...u, ...rows])
      queue.current = queue.current.then(async () => {
        const b = await ensureBatch()
        for (const [n, row] of rows.entries()) {
          progress(`Importing ${n + 1}/${rows.length}…`)
          if (b) await api.importUpload(b, row.file).then(upsert, (e) => setError(`${row.name}: ${(e as Error).message}`))
          setUploading((u) => u.filter((x) => x.key !== row.key))
        }
        progress(null)
      })
    },
    [ensureBatch, upsert, progress],
  )

  /** Files to bring in: anything big waits for a yes first. */
  const add = useCallback(
    (list: File[]) => {
      setBig((b) => [...b, ...list.filter((f) => f.size > BIG)])
      send(list.filter((f) => f.size <= BIG))
    },
    [send],
  )

  // Once per opening: React's development mode runs mount effects twice, which would send every file twice.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    ensureBatch()
    api.tags().then(setVaultTags, () => {})
    if (files?.length) add(files)
    if (pick) input.current?.click()
    sheet.current?.focus()
    // Once, on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const imported = items.filter((it) => it.imported).map((it) => it.imported!.path)
  const close = useCallback(() => {
    if (busy) return
    onClose(batch, imported)
  }, [busy, batch, imported, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const sel = items.find((it) => it.id === selected)
  const selChoice = sel ? choices[sel.id] : undefined
  useEffect(() => {
    if (!batch || !sel || sel.status === 'pending' || sel.status === 'failed') return setPreview('')
    let live = true
    api.importPreview(batch, sel.id, selChoice?.platform ?? '', selChoice?.tags ?? []).then(
      (text) => live && setPreview(text),
      () => live && setPreview(''),
    )
    return () => {
      live = false
    }
    // The labels as text, so a new array with the same labels doesn't ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch, sel?.id, sel?.status, selChoice?.platform, selChoice?.tags.join('\n')])

  const choose = (id: string, patch: Partial<Choice>) => setChoices((c) => ({ ...c, [id]: { ...c[id], ...patch } }))
  /** Labels for every file: what's added joins each file not yet imported, what's removed leaves them. */
  const changeBatchTags = (next: string[]) => {
    const prev = batchTagsRef.current
    const lower = (l: string[]) => new Set(l.map((t) => t.toLowerCase()))
    const added = next.filter((t) => !lower(prev).has(t.toLowerCase()))
    const gone = lower(prev.filter((t) => !lower(next).has(t.toLowerCase())))
    batchTagsRef.current = next
    setBatchTags(next)
    setChoices((c) =>
      Object.fromEntries(
        Object.entries(c).map(([id, ch]) => {
          if (items.find((it) => it.id === id)?.imported) return [id, ch]
          const kept = ch.tags.filter((t) => !gone.has(t.toLowerCase()))
          return [id, { ...ch, tags: [...kept, ...added.filter((t) => !lower(kept).has(t.toLowerCase()))] }]
        }),
      ),
    )
  }
  const setKind = (id: string, platform: string) => {
    const c = choices[id]
    // The folder follows the kind, unless the writer typed one of their own.
    const auto = !c || c.folder === defaultFolder(c.platform) || c.folder === DEFAULT_FOLDER
    choose(id, { platform, ...(auto ? { folder: defaultFolder(platform) } : {}) })
  }

  const shown = items.filter((it) => !skipped.has(it.id))
  const toImport = shown.filter((it) => choices[it.id]?.checked && importable(it))

  const importSelected = () => {
    if (!batch || !toImport.length) return
    const list = toImport
    queue.current = queue.current.then(async () => {
      setError(null)
      const done: string[] = []
      for (const [n, it] of list.entries()) {
        progress(`Importing ${n + 1}/${list.length}…`)
        const c = choices[it.id]
        try {
          const next = await api.importCommit(batch, it.id, c.platform, c.folder, c.tags)
          upsert(next)
          if (next.imported) done.push(next.imported.path)
        } catch (e) {
          setError(`${it.name}: ${(e as Error).message}`)
        }
      }
      progress(null)
      if (done.length) onImported(done)
    })
  }

  const skip = () => {
    if (!sel) return
    const rest = shown.filter((it) => it.id !== sel.id)
    setSkipped((s) => new Set(s).add(sel.id))
    setSelected(rest.find((it) => !it.imported)?.id ?? rest[0]?.id ?? null)
  }

  const undoAll = () => {
    if (!batch) return
    queue.current = queue.current.then(async () => {
      progress('Undoing the import…')
      try {
        const result = await api.importUndo(batch)
        const undone = new Set(items.filter((it) => it.imported).map((it) => it.id))
        setItems((list) => list.map((it) => ({ ...it, imported: undefined })))
        // Undone rows can be imported again, so they're ticked again.
        setChoices((c) => Object.fromEntries(Object.entries(c).map(([id, ch]) => [id, undone.has(id) ? { ...ch, checked: true } : ch])))
        onUndone(result)
      } catch (e) {
        setError((e as Error).message)
      }
      progress(null)
    })
  }

  const allFolders = useMemo(() => [...new Set([DEFAULT_FOLDER, ...kinds().map((k) => k.folder), ...folders.filter((f) => f && !f.startsWith('_'))])].sort(), [folders])
  const fm = splitFrontMatter(preview)
  const checkable = shown.filter(importable)
  const allChecked = checkable.length > 0 && checkable.every((it) => choices[it.id]?.checked)

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      // Files dropped anywhere while the sheet is open join the import (instead of the browser opening them).
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragging(false)}
      onDrop={(e) => {
        setDragging(false)
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        add([...e.dataTransfer.files])
      }}
    >
      <div className={`sheet import-sheet${dragging ? ' is-dragging' : ''}`} role="dialog" aria-label="Import" tabIndex={-1} ref={sheet}>
        <header className="sheet-head">
          <h2>Import</h2>
          <div className="import-head-actions">
            <button className="btn" onClick={() => input.current?.click()}>
              Choose files…
            </button>
            <button className="icon-btn" aria-label="Close" title={busy ? 'Wait for the import to finish' : 'Close (Esc)'} disabled={!!busy} onClick={close}>
              ✕
            </button>
          </div>
        </header>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          onChange={(e) => {
            add([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        {big.length > 0 && (
          <div className="import-confirm" role="alert">
            <span>
              {big.length === 1 ? `“${big[0].name}” is ${mb(big[0].size)}.` : `${big.length} files are over 50 MB (${big.map((f) => f.name).join(', ')}).`} Large files take a while to convert.
            </span>
            <button
              className="btn primary"
              onClick={() => {
                send(big)
                setBig([])
              }}
            >
              Import {big.length === 1 ? 'it' : 'them'} too
            </button>
            <button className="btn" onClick={() => setBig([])}>
              Leave {big.length === 1 ? 'it' : 'them'} out
            </button>
          </div>
        )}
        {error && (
          <p className="import-error" role="alert">
            {error}
            <button className="icon-btn small" aria-label="Dismiss" onClick={() => setError(null)}>
              ✕
            </button>
          </p>
        )}
        {!shown.length && !uploading.length ? (
          <div className="import-empty">
            <p>{batch ? 'Choose files to bring into your vault, or drop them here.' : 'Looking in _inbox…'}</p>
            <p className="muted">
              Word (.docx), PDFs with text, web pages (.html), text, rich text (.rtf), CSV and Markdown files become notes you can review first. Anything you put in the vault’s <code>_inbox</code>{' '}
              folder shows up here too.
              {!pandoc && batch ? ' Installing Pandoc gives the best Word conversions.' : ''}
            </p>
          </div>
        ) : (
          <div className="import-body">
            <div className="import-list" role="listbox" aria-label="Files to import" aria-activedescendant={selected ? `import-row-${selected}` : undefined}>
              <label className="import-all">
                <input
                  type="checkbox"
                  checked={allChecked}
                  disabled={!checkable.length}
                  onChange={(e) => setChoices((c) => ({ ...c, ...Object.fromEntries(checkable.map((it) => [it.id, { ...c[it.id], checked: e.target.checked }])) }))}
                />
                <span>
                  {toImport.length} of {shown.length} selected
                </span>
                {!labelsOpen && (
                  <button
                    className="link-btn import-labels-open"
                    onClick={(e) => {
                      e.preventDefault() // not the tick box this sits beside
                      setLabelsOpen(true)
                    }}
                  >
                    {batchTags.length ? `Labels: ${batchTags.join(', ')}` : 'Add labels…'}
                  </button>
                )}
              </label>
              {labelsOpen && (
                <div className="import-labels is-batch">
                  <span className="import-labels-name">Labels for every file</span>
                  <LabelField label="Labels for every file" values={batchTags} onChange={changeBatchTags} autoFocus />
                  <button className="link-btn" onClick={() => setLabelsOpen(false)}>
                    Done
                  </button>
                </div>
              )}
              {shown.map((it) => {
                const c = choices[it.id]
                return (
                  <div
                    key={it.id}
                    id={`import-row-${it.id}`}
                    role="option"
                    aria-selected={it.id === selected}
                    className={`import-row${it.id === selected ? ' is-on' : ''}${it.imported ? ' is-done' : ''}`}
                    onClick={() => setSelected(it.id)}
                    // Tabbing into a row's tick box, kind or folder shows that row's preview too, so the sheet works without a mouse.
                    onFocusCapture={() => setSelected(it.id)}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Import ${it.name}`}
                      checked={!!c?.checked && importable(it)}
                      disabled={!importable(it)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => choose(it.id, { checked: e.target.checked })}
                    />
                    <span className={`import-type is-${it.type}`} aria-hidden="true">
                      {TYPE_LABEL[it.type]}
                    </span>
                    <div className="import-main">
                      <div className="import-line">
                        <span className="import-name" title={it.inbox ?? it.name}>
                          {it.name}
                        </span>
                        <span className={`import-status is-${it.imported ? 'done' : it.status}`} title={it.reason ?? it.notes.join('. ')}>
                          {it.imported ? 'Imported' : STATUS_LABEL[it.status]}
                        </span>
                      </div>
                      <div className="import-line muted">
                        {it.imported ? (
                          <span className="import-where">{it.imported.path}</span>
                        ) : it.status === 'failed' ? (
                          <span className="import-reason">{it.reason}</span>
                        ) : (
                          <>
                            <span>
                              {[converterLabel(it.converter), it.status === 'pending' ? '' : `${it.words.toLocaleString()} words`, it.inbox ? 'from _inbox' : ''].filter(Boolean).join(' · ')}
                            </span>
                            {c && it.status !== 'pending' && (
                              <span className="import-dest" onClick={(e) => e.stopPropagation()}>
                                <select aria-label={`Kind for ${it.name}`} value={c.platform} onChange={(e) => setKind(it.id, e.target.value)}>
                                  <option value="">No kind</option>
                                  {kinds().map((k) => (
                                    <option key={k.id} value={k.id}>
                                      {k.name}
                                    </option>
                                  ))}
                                </select>
                                <input aria-label={`Folder for ${it.name}`} list="import-folders" value={c.folder} onChange={(e) => choose(it.id, { folder: e.target.value })} />
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
              {uploading.map((u) => (
                <div key={u.key} className="import-row is-waiting">
                  <input type="checkbox" disabled aria-label={`${u.name}, waiting`} />
                  <span className="import-type" aria-hidden="true">
                    …
                  </span>
                  <div className="import-main">
                    <div className="import-line">
                      <span className="import-name">{u.name}</span>
                      <span className="import-status is-pending">Waiting…</span>
                    </div>
                    <div className="import-line muted">{mb(u.size)}</div>
                  </div>
                </div>
              ))}
              <datalist id="import-tags">
                {vaultTags.map((t) => (
                  <option key={t.tag} value={t.tag} />
                ))}
              </datalist>
              <datalist id="import-folders">
                {allFolders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </div>
            <div className="import-preview" aria-label="Preview">
              {!sel ? null : sel.status === 'failed' ? (
                <div className="import-preview-note">
                  <b>{sel.name} couldn’t be imported.</b>
                  <p>{sel.reason}</p>
                </div>
              ) : sel.status === 'pending' ? (
                <p className="muted">Converting…</p>
              ) : (
                <>
                  {(sel.notes.length > 0 || sel.reason) && (
                    <ul className="import-notes">
                      {sel.reason && <li>{sel.reason}</li>}
                      {sel.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  )}
                  {!sel.imported && selChoice && (
                    <div className="import-labels">
                      <span className="import-labels-name">Labels</span>
                      <LabelField label={`Labels for ${sel.name}`} values={selChoice.tags} onChange={(tags) => choose(sel.id, { tags })} />
                    </div>
                  )}
                  <dl className="import-meta">
                    {Object.entries(fm.meta).map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="import-md" dangerouslySetInnerHTML={{ __html: md.render(fm.body) }} />
                </>
              )}
            </div>
          </div>
        )}
        <footer className="import-foot">
          <span className="muted import-busy" aria-live="polite">
            {busy ?? (imported.length ? `${imported.length} imported. The originals are kept in .ekdanta/import.` : '')}
          </span>
          <div className="import-foot-actions">
            {imported.length > 0 && (
              <button className="btn" disabled={!!busy} onClick={undoAll}>
                Undo import
              </button>
            )}
            <button className="btn" disabled={!sel || !!busy} onClick={skip}>
              Skip
            </button>
            <button className="btn primary" disabled={!toImport.length || !!busy} onClick={importSelected}>
              Import selected{toImport.length ? ` (${toImport.length})` : ''}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

/** Labels as chips. Return or a comma adds one; Backspace in an empty field takes the last off. The vault's tags are suggested. */
function LabelField({ label, values, onChange, autoFocus }: { label: string; values: string[]; onChange: (v: string[]) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('')
  const add = (raw: string) => {
    const next = [...values]
    for (const t of raw.split(',').map(cleanTag).filter(Boolean)) if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t)
    setText('')
    if (next.length !== values.length) onChange(next)
  }
  return (
    <span className="prop-chips">
      {values.map((v) => (
        <span key={v} className="prop-chip">
          #{v}
          <button className="prop-chip-x" aria-label={`Remove #${v}`} title={`Remove #${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <span className="prop-chips-field">
        <input
          className="prop-chips-input"
          aria-label={label}
          autoFocus={autoFocus}
          placeholder={values.length ? '' : 'Add a label…'}
          list="import-tags"
          value={text}
          onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setText(e.target.value))}
          onBlur={() => text.trim() && add(text)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (text.trim()) add(text)
            } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1))
            else if (e.key === 'Escape' && text) {
              // Escape clears what's typed; a second one closes the sheet.
              e.stopPropagation()
              e.nativeEvent.stopImmediatePropagation()
              setText('')
            }
          }}
        />
      </span>
    </span>
  )
}
