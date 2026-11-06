import { useEffect, useRef, useState } from 'react'
import { redo, undo } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import type { EditorFormat } from '../editor/Editor.tsx'
import { SLASH } from '../editor/complete.ts'
import { clearFormatting, indentLess, indentMore, insertLink, setBlock, toggleMark, type Block, type Mark } from '../editor/format.ts'
import { Icon } from './Icon.tsx'
import { binding, formatKey, titled } from '../lib/keys.ts'

const STYLES: { block: Block; label: string; id: string }[] = [
  { block: 'p', label: 'Normal text', id: 'p' },
  { block: 'h1', label: 'Heading 1', id: 'h1' },
  { block: 'h2', label: 'Heading 2', id: 'h2' },
  { block: 'h3', label: 'Heading 3', id: 'h3' },
  { block: 'quote', label: 'Quote', id: 'quote' },
  { block: 'code', label: 'Code block', id: 'codeblock' },
]

interface Props {
  view: EditorView | null
  format: EditorFormat | null
  livePreview: boolean
  onLivePreview: (on: boolean) => void
}

/** The formatting toolbar, laid out like Google Docs': history, style, marks, lists, insert, tools. */
export function Toolbar({ view, format, livePreview, onLivePreview }: Props) {
  const [insertOpen, setInsertOpen] = useState(false)
  const insertRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!insertOpen) return
    const away = (e: MouseEvent) => !insertRef.current?.contains(e.target as Node) && setInsertOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setInsertOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [insertOpen])

  // Every button acts on mousedown and keeps the editor's selection.
  const act = (fn: (v: EditorView) => unknown) => (e: React.MouseEvent) => {
    e.preventDefault()
    if (view) fn(view)
  }
  const on = (m: Mark) => !!format?.marks.includes(m)
  const block = format?.block ?? 'p'
  const styleValue = STYLES.some((s) => s.block === block) ? block : 'p'

  const Btn = ({ icon, label, title, run, active, disabled }: { icon?: string; label?: string; title: string; run: (v: EditorView) => unknown; active?: boolean; disabled?: boolean }) => (
    <button className={`tb-btn${active ? ' is-on' : ''}${label ? ' is-text' : ''}`} title={title} aria-label={title.split('  ')[0]} aria-pressed={active} disabled={disabled || !view} onMouseDown={act(run)}>
      {icon ? <Icon name={icon} /> : label}
    </button>
  )

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <Btn icon="undo" title="Undo  ⌘Z" run={undo} disabled={!format?.canUndo} />
      <Btn icon="redo" title="Redo  ⌘⇧Z" run={redo} disabled={!format?.canRedo} />
      <span className="tb-sep" />
      <label className="tb-style" title={STYLES.map((x) => (binding(x.id) ? `${x.label}  ${formatKey(binding(x.id))}` : x.label)).join('\n')}>
        <select
          value={styleValue}
          disabled={!view}
          onChange={(e) => {
            if (view) setBlock(e.target.value as Block, false)(view)
          }}
          aria-label="Text style"
        >
          {STYLES.map((s) => (
            <option key={s.block} value={s.block}>
              {s.label}
            </option>
          ))}
        </select>
        <svg className="chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.5 4.75 6 7.25l2.5-2.5" />
        </svg>
      </label>
      <span className="tb-sep" />
      <Btn icon="bold" title={titled('Bold', 'bold')} run={toggleMark('bold')} active={on('bold')} />
      <Btn icon="italic" title={titled('Italic', 'italic')} run={toggleMark('italic')} active={on('italic')} />
      <Btn icon="underline" title={titled('Underline', 'underline')} run={toggleMark('underline')} active={on('underline')} />
      <Btn icon="strike" title={titled('Strikethrough', 'strike')} run={toggleMark('strike')} active={on('strike')} />
      <Btn icon="highlight" title={titled('Highlight', 'highlight')} run={toggleMark('highlight')} active={on('highlight')} />
      <Btn icon="code" title={titled('Inline code', 'code')} run={toggleMark('code')} active={on('code')} />
      <Btn icon="link" title={titled('Link', 'link')} run={insertLink()} active={on('link')} />
      <span className="tb-sep" />
      <Btn icon="bullets" title={titled('Bulleted list', 'bullet')} run={setBlock('bullet')} active={block === 'bullet'} />
      <Btn icon="numbers" title={titled('Numbered list', 'number')} run={setBlock('number')} active={block === 'number'} />
      <Btn icon="todo" title={titled('Checklist', 'todo')} run={setBlock('todo')} active={block === 'todo'} />
      <Btn icon="outdent" title={titled('Decrease indent', 'outdent')} run={indentLess} />
      <Btn icon="indent" title={titled('Increase indent', 'indent')} run={indentMore} />
      <span className="tb-sep" />
      <div className="tb-insert" ref={insertRef}>
        <button className="tb-btn is-text" title="Insert  ·  or type / on a new line" disabled={!view} aria-haspopup="menu" aria-expanded={insertOpen} onMouseDown={(e) => (e.preventDefault(), setInsertOpen((o) => !o))}>
          Insert
          <svg className="chevron" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3.5 4.75 6 7.25l2.5-2.5" />
          </svg>
        </button>
        {insertOpen && (
          <div className="menu tb-menu" role="menu">
            {SLASH.filter((s) => s.section === 'Insert').map((s) => (
              <button
                key={s.label}
                role="menuitem"
                onMouseDown={(e) => {
                  e.preventDefault()
                  setInsertOpen(false)
                  if (view) s.run(view)
                }}
              >
                {s.label}
                {s.detail && <span className="muted">{s.detail}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <Btn icon="clear" title={titled('Clear formatting', 'clear')} run={clearFormatting} />
      <div className="spacer" />
      <Btn icon="search" title={titled('Find and replace', 'find')} run={(v) => openSearchPanel(v)} />
      <button
        className={`tb-btn${!livePreview ? ' is-on' : ''}`}
        title={livePreview ? 'Show the Markdown' : 'Show formatted (Live Preview)'}
        aria-pressed={!livePreview}
        onMouseDown={(e) => {
          e.preventDefault()
          onLivePreview(!livePreview)
        }}
      >
        <Icon name="markdown" />
      </button>
    </div>
  )
}
