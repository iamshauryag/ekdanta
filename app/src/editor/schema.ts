// The document model, as in Google Docs, Notion and every ProseMirror editor: blocks hold text, and
// formatting is an attribute of the text, never characters in it. Markdown exists only at the edges,
// when a file is read (markdown.ts) and written. So no edit can leave half a pair of `**` behind.
import { Extension, Node, mergeAttributes, type AnyExtension } from '@tiptap/core'
import { Blockquote } from '@tiptap/extension-blockquote'
import { Bold } from '@tiptap/extension-bold'
import { Code } from '@tiptap/extension-code'
import { CodeBlock } from '@tiptap/extension-code-block'
import { Heading } from '@tiptap/extension-heading'
import { Highlight } from '@tiptap/extension-highlight'
import { HardBreak } from '@tiptap/extension-hard-break'
import { Image } from '@tiptap/extension-image'
import { Italic } from '@tiptap/extension-italic'
import { BulletList, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Strike } from '@tiptap/extension-strike'
import { TableKit } from '@tiptap/extension-table'
import { Underline } from '@tiptap/extension-underline'
import { Fragment, Slice, type Mark, type Node as PMNode, type ResolvedPos, type Schema } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { StarterKit } from '@tiptap/starter-kit'

/** What the editor needs from the app to show links and images. */
export interface Resolver {
  /** A page's title for a [[link]], if the page exists. */
  pageTitle: (target: string) => string | undefined
  /** Where an image linked from this document is loaded from. */
  assetUrl: (src: string) => string
}
export const resolver: Resolver = { pageTitle: () => undefined, assetUrl: (s) => s }

// Formatting keys are Ekdanta's own and remappable (lib/keys.ts), so the built-in ones are removed.
const noKeys = { addKeyboardShortcuts: () => ({}) }

/** [[target|label]]: a link to another page in the vault, kept whole like a single character. */
export const PageLink = Node.create({
  name: 'pageLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ target: { default: '' }, label: { default: null } }),
  parseHTML: () => [{ tag: 'span[data-page]', getAttrs: (el) => ({ target: (el as HTMLElement).dataset.page, label: (el as HTMLElement).dataset.label || null }) }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const title = node.attrs.label || resolver.pageTitle(node.attrs.target) || node.attrs.target
    const missing = !resolver.pageTitle(node.attrs.target)
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-page': node.attrs.target,
        'data-label': node.attrs.label ?? '',
        class: 'pm-pagelink' + (missing ? ' is-missing' : ''),
        title: missing ? `No page called “${node.attrs.target}” yet` : `${node.attrs.target} · ⌘-click to open`,
      }),
      title,
    ]
  },
  renderText: ({ node }) => node.attrs.label || resolver.pageTitle(node.attrs.target) || node.attrs.target,
})

/** Markdown the editor doesn't show as anything else (an HTML block, say), kept exactly as written. */
export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({ text: { default: '' } }),
  parseHTML: () => [{ tag: 'pre[data-raw]', getAttrs: (el) => ({ text: (el as HTMLElement).textContent }) }],
  renderHTML: ({ node }) => ['pre', { 'data-raw': '', class: 'pm-raw', title: 'Kept as written in the file' }, node.attrs.text],
})

/** Inline HTML other than <u>, kept as written. */
export const RawInline = Node.create({
  name: 'rawInline',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ text: { default: '' } }),
  parseHTML: () => [{ tag: 'code[data-raw]', getAttrs: (el) => ({ text: (el as HTMLElement).textContent }) }],
  renderHTML: ({ node }) => ['code', { 'data-raw': '', class: 'pm-raw-inline' }, node.attrs.text],
  renderText: ({ node }) => node.attrs.text,
})

/** Images keep the path written in the file, and are shown from the vault. */
const VaultImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: { default: null, renderHTML: (a) => ({ src: a.src ? resolver.assetUrl(a.src) : null, 'data-src': a.src }) },
    }
  },
  parseHTML: () => [
    {
      tag: 'img[src]',
      getAttrs: (el) => ({
        src: (el as HTMLElement).dataset.src || (el as HTMLImageElement).getAttribute('src'),
        alt: (el as HTMLImageElement).alt || null,
        title: (el as HTMLImageElement).title || null,
      }),
    },
  ],
}).configure({ inline: true, allowBase64: false })

/** Return in a heading starts a normal paragraph, and Shift-Return is a line break, as in Docs. */
const LineBreak = HardBreak.extend({
  // How the file writes the break before its newline: nothing (a plain line break, as Obsidian writes
  // one), or Markdown's `\` or trailing spaces when the file had those.
  addAttributes: () => ({ markup: { default: '', rendered: false } }),
  addKeyboardShortcuts() {
    return { 'Shift-Enter': () => this.editor.commands.setHardBreak() }
  },
})

/** Nothing on the page yet: one empty line, which is what a new document is. */
export function isBlank(doc: PMNode) {
  const only = doc.childCount === 1 ? doc.firstChild : null
  return !!only && only.type.name === 'paragraph' && only.content.size === 0
}

/** The hint on a blank page. Once anything is written it's gone, and new lines don't bring it back. */
export function hintDecorations(state: EditorState, text: string) {
  if (!isBlank(state.doc)) return null
  return DecorationSet.create(state.doc, [Decoration.node(0, state.doc.firstChild!.nodeSize, { class: 'is-empty', 'data-placeholder': text })])
}

const Hint = Extension.create<{ text: string }>({
  name: 'hint',
  addOptions: () => ({ text: '' }),
  addProseMirrorPlugins() {
    const text = this.options.text
    return [new Plugin({ key: new PluginKey('hint'), props: { decorations: (state) => hintDecorations(state, text) } })]
  },
})

/**
 * Plain text pasted (from a text editor, a terminal, the Markdown view): a blank line starts a new
 * paragraph and a single newline is a line break, as they are in a Markdown file. ProseMirror on its
 * own makes every line a paragraph, which turns each line break into a paragraph break. A heading or a
 * table cell is one line in the file, so there the lines are joined with spaces (and a cell's paragraphs too).
 */
export function plainTextSlice(schema: Schema, text: string, marks: readonly Mark[] = [], into: 'text' | 'heading' | 'cell' = 'text'): Slice {
  const clean = text.replace(/\r\n?/g, '\n').replace(/^\s*\n|\n\s*$/g, '')
  const paragraphs = (into === 'cell' ? [clean] : clean.split(/\n[ \t]*\n\s*/)).map((para) => {
    const content: PMNode[] = []
    if (into !== 'text') {
      const line = para.replace(/\s*\n\s*/g, ' ')
      if (line) content.push(schema.text(line, marks))
    } else
      para.split('\n').forEach((line, i) => {
        if (i) content.push(schema.nodes.hardBreak.create())
        if (line) content.push(schema.text(line, marks))
      })
    return schema.nodes.paragraph.create(null, content)
  })
  return Slice.maxOpen(Fragment.from(paragraphs))
}

/** Where pasted text lands: in a heading, a table cell, or ordinary text. */
export function pasteTarget($pos: ResolvedPos): 'text' | 'heading' | 'cell' {
  for (let d = $pos.depth; d > 0; d--) if (['tableCell', 'tableHeader'].includes($pos.node(d).type.name)) return 'cell'
  return $pos.parent.type.name === 'heading' ? 'heading' : 'text'
}

const PlainPaste = Extension.create({
  name: 'plainPaste',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('plainPaste'),
        props: { clipboardTextParser: (text, $context) => plainTextSlice($context.doc.type.schema, text, $context.marks(), pasteTarget($context)) },
      }),
    ]
  },
})

export function extensions(placeholder = 'Start writing, or type / for blocks…'): AnyExtension[] {
  return [
    StarterKit.configure({
      bold: false,
      italic: false,
      strike: false,
      code: false,
      underline: false,
      heading: false,
      paragraph: false,
      blockquote: false,
      bulletList: false,
      orderedList: false,
      codeBlock: false,
      hardBreak: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener', target: null } },
      // Always an empty line at the end, so there's somewhere to type after a table or an image.
      trailingNode: {},
    }),
    Paragraph.extend(noKeys),
    Heading.extend(noKeys).configure({ levels: [1, 2, 3, 4, 5, 6] }),
    Bold.extend(noKeys),
    Italic.extend(noKeys),
    Strike.extend(noKeys),
    Underline.extend(noKeys),
    Code.extend(noKeys),
    Highlight.extend(noKeys),
    Blockquote.extend(noKeys),
    CodeBlock.extend({
      addKeyboardShortcuts() {
        // Keep Return and the arrows leaving the block; the shortcut that makes one is remappable instead.
        const { 'Mod-Alt-c': _make, ...rest } = this.parent?.() ?? {}
        return rest
      },
    }),
    BulletList.extend(noKeys),
    OrderedList.extend(noKeys),
    TaskList.extend(noKeys),
    TaskItem.configure({ nested: true }),
    LineBreak,
    VaultImage,
    TableKit.configure({ table: { resizable: false } }),
    PageLink,
    RawBlock,
    RawInline,
    Hint.configure({ text: placeholder }),
    PlainPaste,
  ]
}

export type { Extension }
