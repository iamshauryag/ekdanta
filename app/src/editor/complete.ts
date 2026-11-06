// Menus the writer asks for by typing: "/" for blocks (as in Notion) and "[[" for a page link
// (as in Obsidian). Nothing else ever pops up while typing.
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { binding, formatKey } from '../lib/keys.ts'
import { insertDate, insertDivider, insertTable, setBlock, type Block } from './format.ts'

export interface PageRef {
  /** The link target: the file name without .md. */
  target: string
  title: string
  folder: string
}

interface SlashItem {
  label: string
  /** The Markdown to type for it. */
  detail: string
  /** Its remappable command, whose key is shown too. */
  cmd?: string
  keywords: string
  section: string
  run: (view: EditorView) => void
}

const block = (kind: Block) => (view: EditorView) => setBlock(kind, false)(view)

export const SLASH: SlashItem[] = [
  { label: 'Text', detail: '', cmd: 'p', keywords: 'paragraph plain normal', section: 'Basic blocks', run: block('p') },
  { label: 'Heading 1', detail: '#', cmd: 'h1', keywords: 'h1 title big', section: 'Basic blocks', run: block('h1') },
  { label: 'Heading 2', detail: '##', cmd: 'h2', keywords: 'h2 subtitle', section: 'Basic blocks', run: block('h2') },
  { label: 'Heading 3', detail: '###', cmd: 'h3', keywords: 'h3', section: 'Basic blocks', run: block('h3') },
  { label: 'Bulleted list', detail: '-', cmd: 'bullet', keywords: 'ul unordered bullet', section: 'Basic blocks', run: block('bullet') },
  { label: 'Numbered list', detail: '1.', cmd: 'number', keywords: 'ol ordered number', section: 'Basic blocks', run: block('number') },
  { label: 'To-do list', detail: '[]', cmd: 'todo', keywords: 'checkbox task checklist todo', section: 'Basic blocks', run: block('todo') },
  { label: 'Quote', detail: '>', cmd: 'quote', keywords: 'blockquote citation', section: 'Basic blocks', run: block('quote') },
  { label: 'Code block', detail: '```', cmd: 'codeblock', keywords: 'pre monospace snippet', section: 'Basic blocks', run: block('code') },
  { label: 'Divider', detail: '---', keywords: 'hr rule line separator', section: 'Insert', run: (v) => insertDivider(v) },
  { label: 'Table', detail: '', keywords: 'grid columns rows', section: 'Insert', run: (v) => insertTable(v) },
  { label: 'Image', detail: 'or paste one', keywords: 'picture photo upload', section: 'Insert', run: (v) => v.dom.dispatchEvent(new CustomEvent('ekdanta:image', { bubbles: true })) },
  {
    label: 'Link to page',
    detail: '[[',
    keywords: 'wikilink page reference',
    section: 'Insert',
    run: (v) => {
      const at = v.state.selection.main.head
      v.dispatch({ changes: { from: at, insert: '[[]]' }, selection: { anchor: at + 2 } })
      // Open the page list straight away.
      import('@codemirror/autocomplete').then(({ startCompletion }) => startCompletion(v))
    },
  },
  { label: "Today's date", detail: '', keywords: 'date now today', section: 'Insert', run: (v) => insertDate(v) },
]

function slashSource(context: CompletionContext): CompletionResult | null {
  // "/" at the start of a line or after a space, so dates and paths aren't interrupted.
  const m = context.matchBefore(/(?:^|\s)\/[\w '-]*$/)
  if (!m) return null
  const from = m.from + (m.text.startsWith('/') ? 0 : 1)
  if (context.state.sliceDoc(from, context.pos).length > 24) return null
  // Match on keywords as well as names ("/h1", "/todo", "/hr"), so the filtering is done here.
  const query = context.state.sliceDoc(from + 1, context.pos).trim().toLowerCase()
  const words = query.split(/\s+/).filter(Boolean)
  const items = SLASH.filter((item) => {
    const hay = `${item.label} ${item.keywords}`.toLowerCase()
    return words.every((w) => hay.split(/\s+/).some((h) => h.startsWith(w)))
  })
  if (!items.length) return null
  return {
    from,
    filter: false,
    options: items.map(
      (item, i): Completion => ({
        label: '/' + item.label,
        displayLabel: item.label,
        detail: [item.cmd && formatKey(binding(item.cmd)), item.detail].filter(Boolean).join('   '),
        section: query ? undefined : item.section,
        type: 'slash',
        boost: -i,
        apply: (view, _c, f, t) => {
          view.dispatch({ changes: { from: f, to: t } })
          item.run(view)
        },
      }),
    ),
  }
}

function wikiSource(pages: () => PageRef[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const m = context.matchBefore(/\[\[[^\]|\n]*$/)
    if (!m) return null
    // Inside [[…]] already (from "Link to page"), the closing brackets are kept.
    const closing = context.state.sliceDoc(context.pos, context.pos + 2) === ']]'
    return {
      from: m.from + 2,
      options: pages().map(
        (p): Completion => ({
          label: p.title,
          detail: p.folder,
          type: 'page',
          apply: (view, _c, from, to) => {
            const insert = p.target + (closing ? '' : ']]')
            view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (closing ? 2 : 0) } })
          },
        }),
      ),
      validFor: /^[^\]|\n]*$/,
    }
  }
}

export function completions(pages: () => PageRef[]) {
  return autocompletion({
    override: [slashSource, wikiSource(pages)],
    icons: false,
    activateOnTyping: true,
    closeOnBlur: true,
    maxRenderedOptions: 40,
    optionClass: (c) => (c.type === 'slash' ? 'cm-slash-option' : 'cm-page-option'),
  })
}
