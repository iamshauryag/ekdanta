// What each formatting command does to the document. The keys for them live in lib/keys.ts and can be
// remapped; the toolbar, the selection bar and the "/" menu all call these same commands.
import type { Editor } from '@tiptap/core'

export type Block = 'p' | 'h1' | 'h2' | 'h3' | 'quote' | 'bullet' | 'number' | 'todo' | 'code'
export type Mark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight' | 'link'

/** Ask the page for the link editor or the find bar (they're drawn by Editor.tsx). */
export const openLinkEditor = () => window.dispatchEvent(new Event('ekdanta:link'))
export const openFind = () => window.dispatchEvent(new Event('ekdanta:find'))

/** Tick or untick the to-do the caret is in. */
function toggleTask(editor: Editor) {
  const { state, view } = editor
  const $from = state.selection.$from
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'taskItem') {
      view.dispatch(state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, checked: !node.attrs.checked }))
      return true
    }
  }
  return false
}

const listItemType = (editor: Editor) => (editor.isActive('taskItem') ? 'taskItem' : 'listItem')

/** Run a command by its id (the same ids as lib/keys.ts). False when it doesn't apply here. */
export function runCommand(editor: Editor, id: string): boolean {
  const c = () => editor.chain().focus()
  switch (id) {
    case 'bold':
      return c().toggleBold().run()
    case 'italic':
      return c().toggleItalic().run()
    case 'underline':
      return c().toggleUnderline().run()
    case 'strike':
      return c().toggleStrike().run()
    case 'code':
      return c().toggleCode().run()
    case 'highlight':
      return c().toggleHighlight().run()
    case 'link':
      openLinkEditor()
      return true
    case 'clear':
      return c().unsetAllMarks().clearNodes().run()
    case 'p':
      return c().setParagraph().run()
    case 'h1':
    case 'h2':
    case 'h3':
      return c()
        .toggleHeading({ level: Number(id[1]) as 1 | 2 | 3 })
        .run()
    case 'quote':
      return c().toggleBlockquote().run()
    case 'codeblock':
      return c().toggleCodeBlock().run()
    case 'number':
      return c().toggleOrderedList().run()
    case 'bullet':
      return c().toggleBulletList().run()
    case 'todo':
      return c().toggleTaskList().run()
    case 'task':
      return toggleTask(editor)
    case 'indent':
      return c().sinkListItem(listItemType(editor)).run()
    case 'outdent':
      return c().liftListItem(listItemType(editor)).run()
    case 'find':
      openFind()
      return true
  }
  return false
}

/** The kind of block the caret is in, for the toolbar's style menu. */
export function blockOf(editor: Editor): Block {
  if (editor.isActive('codeBlock')) return 'code'
  for (const l of [1, 2, 3] as const) if (editor.isActive('heading', { level: l })) return `h${l}`
  if (editor.isActive('taskList')) return 'todo'
  if (editor.isActive('orderedList')) return 'number'
  if (editor.isActive('bulletList')) return 'bullet'
  if (editor.isActive('blockquote')) return 'quote'
  return 'p'
}

const MARKS: Mark[] = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'link']
/** The formatting at the caret (or that typing will get), for the toolbar and the selection bar. */
export const marksOf = (editor: Editor): Mark[] => MARKS.filter((m) => editor.isActive(m))
