import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { EditorFormat } from '../editor/Editor.tsx'
import { runCommand, type Block, type Mark } from '../editor/commands.ts'
import { pickImage } from '../editor/menus.ts'
import { binding, formatKey, titled } from '../lib/keys.ts'
import { Icon } from './Icon.tsx'

const STYLES: { block: Block; label: string; id: string }[] = [
  { block: 'p', label: 'Normal text', id: 'p' },
  { block: 'h1', label: 'Heading 1', id: 'h1' },
  { block: 'h2', label: 'Heading 2', id: 'h2' },
  { block: 'h3', label: 'Heading 3', id: 'h3' },
  { block: 'quote', label: 'Quote', id: 'quote' },
  { block: 'code', label: 'Code block', id: 'codeblock' },
]

const today = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

interface Props {
  editor: Editor | null
  format: EditorFormat | null
  livePreview: boolean
  onLivePreview: (on: boolean) => void
}

/** The formatting toolbar, laid out like Google Docs': history, style, marks, lists, insert, tools. */
export function Toolbar({ editor, format, livePreview, onLivePreview }: Props) {
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

  const off = !editor || !livePreview
  // Every button acts on mousedown and keeps the editor's selection.
  const act = (fn: (e: Editor) => unknown) => (ev: React.MouseEvent) => {
    ev.preventDefault()
    if (editor && livePreview) fn(editor)
  }
  const cmd = (id: string) => (e: Editor) => runCommand(e, id)
  const on = (m: Mark) => !!format?.marks.includes(m)
  const block = format?.block ?? 'p'
  const styleValue = STYLES.some((s) => s.block === block) ? block : 'p'

  const Btn = ({ icon, title, run, active, disabled }: { icon: string; title: string; run: (e: Editor) => unknown; active?: boolean; disabled?: boolean }) => (
    <button className={`tb-btn${active ? ' is-on' : ''}`} title={title} aria-label={title.split('  ')[0]} aria-pressed={active} disabled={disabled || off} onMouseDown={act(run)}>
      <Icon name={icon} />
    </button>
  )

  const insert: { label: string; detail?: string; run: (e: Editor) => unknown }[] = [
    { label: 'Divider', detail: '---', run: (e) => e.chain().focus().setHorizontalRule().run() },
    { label: 'Table', run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run() },
    { label: 'Image', detail: 'or paste one', run: () => pickImage() },
    { label: 'Link to page', detail: '[[', run: (e) => e.chain().focus().insertContent('[[').run() },
    { label: "Today's date", run: (e) => e.chain().focus().insertContent(today()).run() },
  ]

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <Btn icon="undo" title="Undo  ⌘Z" run={(e) => e.chain().focus().undo().run()} disabled={!format?.canUndo} />
      <Btn icon="redo" title="Redo  ⇧⌘Z" run={(e) => e.chain().focus().redo().run()} disabled={!format?.canRedo} />
      <span className="tb-sep" />
      <label className="tb-style" title={STYLES.map((x) => (binding(x.id) ? `${x.label}  ${formatKey(binding(x.id))}` : x.label)).join('\n')}>
        <select
          value={styleValue}
          disabled={off}
          onChange={(e) => {
            if (!editor) return
            const id = STYLES.find((s) => s.block === e.target.value)!.id
            if (id === 'p') editor.chain().focus().setParagraph().run()
            else if (e.target.value !== block) runCommand(editor, id)
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
      <Btn icon="bold" title={titled('Bold', 'bold')} run={cmd('bold')} active={on('bold')} />
      <Btn icon="italic" title={titled('Italic', 'italic')} run={cmd('italic')} active={on('italic')} />
      <Btn icon="underline" title={titled('Underline', 'underline')} run={cmd('underline')} active={on('underline')} />
      <Btn icon="strike" title={titled('Strikethrough', 'strike')} run={cmd('strike')} active={on('strike')} />
      <Btn icon="highlight" title={titled('Highlight', 'highlight')} run={cmd('highlight')} active={on('highlight')} />
      <Btn icon="code" title={titled('Inline code', 'code')} run={cmd('code')} active={on('code')} />
      <Btn icon="link" title={titled('Link', 'link')} run={cmd('link')} active={on('link')} />
      <span className="tb-sep" />
      <Btn icon="bullets" title={titled('Bulleted list', 'bullet')} run={cmd('bullet')} active={block === 'bullet'} />
      <Btn icon="numbers" title={titled('Numbered list', 'number')} run={cmd('number')} active={block === 'number'} />
      <Btn icon="todo" title={titled('Checklist', 'todo')} run={cmd('todo')} active={block === 'todo'} />
      <Btn icon="outdent" title={titled('Decrease indent', 'outdent')} run={cmd('outdent')} />
      <Btn icon="indent" title={titled('Increase indent', 'indent')} run={cmd('indent')} />
      <span className="tb-sep" />
      <div className="tb-insert" ref={insertRef}>
        <button
          className="tb-btn is-text"
          title="Insert  ·  or type / on a new line"
          disabled={off}
          aria-haspopup="menu"
          aria-expanded={insertOpen}
          onMouseDown={(e) => {
            e.preventDefault()
            setInsertOpen((o) => !o)
          }}
        >
          Insert
          <svg className="chevron" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3.5 4.75 6 7.25l2.5-2.5" />
          </svg>
        </button>
        {insertOpen && (
          <div className="menu tb-menu" role="menu">
            {insert.map((s) => (
              <button
                key={s.label}
                role="menuitem"
                onMouseDown={(e) => {
                  e.preventDefault()
                  setInsertOpen(false)
                  if (editor) s.run(editor)
                }}
              >
                {s.label}
                {s.detail && <span className="muted">{s.detail}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <Btn icon="clear" title={titled('Clear formatting', 'clear')} run={cmd('clear')} />
      {format?.inTable && !off && (
        <>
          <span className="tb-sep" />
          <span className="tb-table">
            <button className="tb-btn is-text" title="Add a row below" onMouseDown={act((e) => e.chain().focus().addRowAfter().run())}>
              + Row
            </button>
            <button className="tb-btn is-text" title="Add a column to the right" onMouseDown={act((e) => e.chain().focus().addColumnAfter().run())}>
              + Column
            </button>
            <button className="tb-btn is-text" title="Delete this row" onMouseDown={act((e) => e.chain().focus().deleteRow().run())}>
              − Row
            </button>
            <button className="tb-btn is-text" title="Delete this column" onMouseDown={act((e) => e.chain().focus().deleteColumn().run())}>
              − Column
            </button>
            <button className="tb-btn is-text" title="Delete the table" onMouseDown={act((e) => e.chain().focus().deleteTable().run())}>
              Delete table
            </button>
          </span>
        </>
      )}
      <div className="spacer" />
      <Btn icon="search" title={titled('Find and replace', 'find')} run={cmd('find')} />
      <button
        className={`tb-btn${!livePreview ? ' is-on' : ''}`}
        title={livePreview ? 'Show the Markdown' : 'Back to the formatted page'}
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
