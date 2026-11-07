// Menus the writer asks for by typing: "/" for blocks (as in Notion) and "[[" for a page link
// (as in Obsidian). Nothing else ever pops up while typing.
import { Extension, type Editor, type Range } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion'
import { binding, formatKey } from '../lib/keys.ts'
import type { TemplateInfo } from '../lib/templates.ts'
import { runCommand } from './commands.ts'

export interface PageRef {
  /** The link target: the file name without .md. */
  target: string
  title: string
  folder: string
}

interface Item {
  label: string
  /** Shown on the right: the Markdown for it, or where it lives. */
  detail?: string
  section?: string
  keywords?: string
  /** The remappable command it runs, whose key is shown too. */
  cmd?: string
  /** Left out of the menu when this says so (a feature the browser can't do). */
  hidden?: () => boolean
  run: (editor: Editor, range: Range) => void
}

const today = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

/** Ask the page for an image file (the Editor component opens the picker). */
export const pickImage = () => window.dispatchEvent(new Event('ekdanta:image'))

const blockItem = (label: string, cmd: string, detail: string, keywords: string): Item => ({
  label,
  cmd,
  detail,
  keywords,
  section: 'Basic blocks',
  run: (editor, range) => {
    editor.chain().focus().deleteRange(range).run()
    // "Text" always means plain text; the others toggle, so turn the block into exactly this.
    if (cmd === 'p') editor.chain().setParagraph().run()
    else if (!(cmd === 'h1' || cmd === 'h2' || cmd === 'h3') || !editor.isActive('heading', { level: Number(cmd[1]) })) runCommand(editor, cmd)
  },
})

export const SLASH: Item[] = [
  blockItem('Text', 'p', '', 'paragraph plain normal'),
  blockItem('Heading 1', 'h1', '#', 'h1 title big'),
  blockItem('Heading 2', 'h2', '##', 'h2 subtitle'),
  blockItem('Heading 3', 'h3', '###', 'h3'),
  blockItem('Bulleted list', 'bullet', '-', 'ul unordered bullet'),
  blockItem('Numbered list', 'number', '1.', 'ol ordered number'),
  blockItem('To-do list', 'todo', '[]', 'checkbox task checklist todo'),
  blockItem('Quote', 'quote', '>', 'blockquote citation'),
  blockItem('Code block', 'codeblock', '```', 'pre monospace snippet'),
  {
    label: 'Divider',
    detail: '---',
    keywords: 'hr rule line separator',
    section: 'Insert',
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    label: 'Table',
    keywords: 'grid columns rows',
    section: 'Insert',
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run(),
  },
  {
    label: 'Image',
    detail: 'or paste one',
    keywords: 'picture photo upload',
    section: 'Insert',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run()
      pickImage()
    },
  },
  {
    label: 'Link to page',
    detail: '[[',
    keywords: 'wikilink page reference',
    section: 'Insert',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent('[[').run(),
  },
  { label: "Today's date", keywords: 'date now today', section: 'Insert', run: (e, r) => e.chain().focus().deleteRange(r).insertContent(today()).run() },
  {
    label: 'Read aloud',
    cmd: 'readAloud',
    detail: 'from here',
    keywords: 'listen speak voice hear tts proofread',
    section: 'Listen',
    // Only when the browser has a voice to read with.
    hidden: () => !(typeof window !== 'undefined' && window.speechSynthesis?.getVoices().length),
    run: (e, r) => {
      e.chain().focus().deleteRange(r).run()
      window.dispatchEvent(new Event('ekdanta:read-aloud'))
    },
  },
]

/** Match on keywords as well as names ("/h1", "/todo", "/hr"). */
function filterSlash(query: string, templates: TemplateItems) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const match = (item: Item) => {
    if (item.hidden?.()) return false
    const hay = `${item.label} ${item.keywords ?? ''}`.toLowerCase().split(/\s+/)
    return words.every((w) => hay.some((h) => h.startsWith(w)))
  }
  const list = templates.list()
  // The vault's templates are listed by name once "/template" (or a name) is typed; before that, one entry stands for them all.
  const named: Item[] = list.map((t) => ({
    label: `Template: ${t.name}`,
    keywords: `template templates ${t.name}`,
    section: 'Templates',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run()
      templates.insert(t)
    },
  }))
  const entry: Item = {
    label: 'Template',
    detail: list.length ? `${list.length} in templates/` : 'add some',
    keywords: 'template templates structure starter',
    section: 'Insert',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run()
      if (list.length) editor.chain().insertContent('/template').run()
      else templates.browse()
    },
  }
  const items = SLASH.filter(match)
  const hits = words.length ? named.filter(match) : []
  return hits.length ? [...items, ...hits] : [...items, ...(match(entry) ? [entry] : [])]
}

/** The vault's templates, for the "/" menu. */
export interface TemplateItems {
  list: () => TemplateInfo[]
  /** Put this template's text in at the caret. */
  insert: (t: TemplateInfo) => void
  /** Show every template (with a way to add the starter set when there are none). */
  browse: () => void
}

// ---- A small menu, drawn next to the caret ---------------------------------------------------

function menuRenderer(kind: 'slash' | 'page') {
  let root: HTMLElement | null = null
  let unmount: (() => void) | null = null
  let selected = 0
  let props: SuggestionProps<Item> | null = null

  const draw = () => {
    if (!root || !props) return
    root.replaceChildren()
    if (!props.items.length) {
      const empty = document.createElement('div')
      empty.className = 'pm-menu-empty'
      empty.textContent = kind === 'page' ? 'No page by that name' : 'No matching block'
      root.append(empty)
      return
    }
    let section = ''
    props.items.forEach((item, i) => {
      if (kind === 'slash' && !props!.query && item.section && item.section !== section) {
        section = item.section
        const h = document.createElement('div')
        h.className = 'pm-menu-section'
        h.textContent = section
        root!.append(h)
      }
      const row = document.createElement('button')
      row.className = 'pm-menu-item' + (i === selected ? ' is-sel' : '')
      row.tabIndex = -1
      const name = document.createElement('span')
      name.textContent = item.label
      const detail = document.createElement('span')
      detail.className = 'pm-menu-detail'
      detail.textContent = [item.cmd && formatKey(binding(item.cmd)), item.detail].filter(Boolean).join('   ')
      row.append(name, detail)
      row.onmousedown = (e) => {
        e.preventDefault()
        props!.command(item)
      }
      row.onmouseenter = () => {
        selected = i
        root!.querySelectorAll('.pm-menu-item').forEach((r, k) => r.classList.toggle('is-sel', k === i))
      }
      root!.append(row)
    })
    root.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' })
  }

  return {
    onStart: (p: SuggestionProps<Item>) => {
      props = p
      selected = 0
      root = document.createElement('div')
      root.className = 'pm-menu'
      root.setAttribute('role', 'listbox')
      document.body.append(root)
      unmount = p.mount(root)
      draw()
    },
    onUpdate: (p: SuggestionProps<Item>) => {
      props = p
      selected = Math.min(selected, Math.max(0, p.items.length - 1))
      draw()
    },
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (!props) return false
      const n = props.items.length
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!n) return true
        selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + n) % n
        draw()
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (!n) return false
        props.command(props.items[selected])
        return true
      }
      return event.key === 'Escape'
    },
    onExit: () => {
      unmount?.()
      root?.remove()
      root = null
      props = null
    },
  }
}

export const SlashMenu = Extension.create<{ templates: TemplateItems }>({
  name: 'slashMenu',
  addOptions: () => ({ templates: { list: () => [], insert: () => {}, browse: () => {} } }),
  addProseMirrorPlugins() {
    const templates = this.options.templates
    return [
      Suggestion<Item, Item>({
        editor: this.editor,
        pluginKey: new PluginKey('slashMenu'),
        char: '/',
        // At the start of a line or after a space, so dates and paths aren't interrupted.
        allowedPrefixes: [' '],
        items: ({ query }) => filterSlash(query, templates),
        command: ({ editor, range, props }) => props.run(editor, range),
        allow: ({ editor }) => !editor.isActive('codeBlock'),
        render: () => menuRenderer('slash'),
      }),
    ]
  },
})

export const PageLinkMenu = Extension.create<{ pages: () => PageRef[] }>({
  name: 'pageLinkMenu',
  addOptions: () => ({ pages: () => [] }),
  addProseMirrorPlugins() {
    const pages = () => this.options.pages()
    return [
      Suggestion<Item, Item>({
        editor: this.editor,
        pluginKey: new PluginKey('pageLinkMenu'),
        char: '[[',
        allowSpaces: true,
        allowedPrefixes: null,
        items: ({ query }) => {
          const q = query.toLowerCase()
          return pages()
            .filter((p) => !q || p.title.toLowerCase().includes(q) || p.target.includes(q))
            .slice(0, 30)
            .map((p): Item => ({
              label: p.title,
              detail: p.folder,
              run: (editor, range) => {
                // Typed brackets that were closed already ("[[…]]") go too.
                const after = editor.state.doc.textBetween(range.to, Math.min(editor.state.doc.content.size, range.to + 2))
                const to = after === ']]' ? range.to + 2 : range.to
                editor
                  .chain()
                  .focus()
                  .deleteRange({ from: range.from, to })
                  .insertContent([
                    { type: 'pageLink', attrs: { target: p.target, label: null } },
                    { type: 'text', text: ' ' },
                  ])
                  .run()
              },
            }))
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => menuRenderer('page'),
      }),
    ]
  },
})
