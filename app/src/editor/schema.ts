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
import { Placeholder } from '@tiptap/extensions'
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
    return ['span', mergeAttributes(HTMLAttributes, { 'data-page': node.attrs.target, 'data-label': node.attrs.label ?? '', class: 'pm-pagelink' + (missing ? ' is-missing' : ''), title: missing ? `No page called “${node.attrs.target}” yet` : `${node.attrs.target} · ⌘-click to open` }), title]
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
  parseHTML: () => [{ tag: 'img[src]', getAttrs: (el) => ({ src: (el as HTMLElement).dataset.src || (el as HTMLImageElement).getAttribute('src'), alt: (el as HTMLImageElement).alt || null, title: (el as HTMLImageElement).title || null }) }],
}).configure({ inline: true, allowBase64: false })

/** Return in a heading starts a normal paragraph, and Shift-Return is a line break, as in Docs. */
const LineBreak = HardBreak.extend({
  // `soft`: a plain line break in the file (one newline), rather than Markdown's `\` break.
  addAttributes: () => ({ soft: { default: true, rendered: false } }),
  addKeyboardShortcuts() {
    return { 'Shift-Enter': () => this.editor.commands.setHardBreak() }
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
    Placeholder.configure({ placeholder, showOnlyCurrent: true }),
  ]
}

export type { Extension }
