// Markdown in and out of the document model.
//
// Files stay the writer's: every top-level block they didn't touch is written back exactly as it was
// in the file (ProseMirror keeps an unchanged block as the very same object, so "untouched" is exact).
// Only blocks that were edited are written fresh, in standard Markdown, and those can't come out
// malformed: formatting is part of the model, so `**bold **` simply can't be produced.
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import type Token from 'markdown-it/lib/token.mjs'
import markPlugin from 'markdown-it-mark'
import { MarkdownParser, MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown'

// ---- Reading ------------------------------------------------------------------------------

function wikilinks(md: MarkdownIt) {
  md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
    const src = state.src
    const start = state.pos
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false
    const end = src.indexOf(']]', start + 2)
    if (end < 0) return false
    const inner = src.slice(start + 2, end)
    if (!inner.trim() || inner.includes('\n') || inner.includes('[')) return false
    if (!silent) {
      const [target, label] = inner.split('|')
      const tok = state.push('wikilink', '', 0)
      tok.meta = { target: target.trim(), label: label?.trim() || null }
    }
    state.pos = end + 2
    return true
  })
}

/** Tokens the document model wants in a slightly different shape. */
function reshape(md: MarkdownIt) {
  md.core.ruler.push('ekdanta', (state: StateCore) => {
    const t = state.tokens
    // <u>…</u> is underline; other inline HTML is kept as written.
    for (const block of t) {
      if (block.type !== 'inline' || !block.children) continue
      for (const c of block.children) {
        if (c.type !== 'html_inline') continue
        if (/^<u>$/i.test(c.content)) {
          c.type = 'u_open'
          c.nesting = 1
        } else if (/^<\/u>$/i.test(c.content)) {
          c.type = 'u_close'
          c.nesting = -1
        } else c.type = 'raw_inline'
      }
    }
    // A table cell holds paragraphs in the model, and inline text in Markdown.
    for (let i = t.length - 1; i >= 0; i--) {
      if (t[i].type === 'th_open' || t[i].type === 'td_open') {
        const p = new state.Token('paragraph_open', 'p', 1)
        t.splice(i + 1, 0, p)
      } else if (t[i].type === 'th_close' || t[i].type === 'td_close') {
        t.splice(i, 0, new state.Token('paragraph_close', 'p', -1))
      }
    }
    // Items that start with [ ] or [x] are to-dos. A list mixing them with plain bullets is split into
    // runs, since a to-do list holds only to-dos (written back, the runs read as one list again).
    for (let i = 0; i < t.length; i++) {
      if (t[i].type !== 'bullet_list_open') continue
      const level = t[i].level
      let j = i + 1
      while (!(t[j].type === 'bullet_list_close' && t[j].level === level)) j++
      // Each item: its tokens, from list_item_open to its list_item_close.
      const items: Token[][] = []
      for (let k = i + 1; k < j; k++) {
        if (t[k].type !== 'list_item_open' || t[k].level !== level + 1) continue
        let m = k + 1
        while (!(t[m].type === 'list_item_close' && t[m].level === level + 1)) m++
        items.push(t.slice(k, m + 1))
        k = m
      }
      const isTask = (item: Token[]) => item[1]?.type === 'paragraph_open' && /^\[[ xX]\]\s/.test(item[2]?.content ?? '')
      if (!items.some(isTask)) continue
      const out: Token[] = []
      let run: 'bullet' | 'task' | null = null
      const close = () => {
        if (!run) return
        const c = new state.Token(run === 'task' ? 'task_list_close' : 'bullet_list_close', 'ul', -1)
        c.level = level
        out.push(c)
      }
      for (const item of items) {
        const kind = isTask(item) ? 'task' : 'bullet'
        if (kind !== run) {
          close()
          const o = new state.Token(kind === 'task' ? 'task_list_open' : 'bullet_list_open', 'ul', 1)
          o.level = level
          o.markup = t[i].markup
          o.block = true
          o.map = item[0].map
          out.push(o)
          run = kind
        }
        if (kind === 'task') {
          const inline = item[2]
          item[0].type = 'task_item_open'
          item[0].meta = { checked: /^\[[xX]\]/.test(inline.content) }
          item[item.length - 1].type = 'task_item_close'
          inline.content = inline.content.slice(4)
          const first = inline.children?.[0]
          if (first?.type === 'text') first.content = first.content.replace(/^\[[ xX]\]\s/, '')
        }
        out.push(...item)
      }
      close()
      // The first run keeps the list's place (and its source lines) in the file.
      out[0].map = t[i].map
      t.splice(i, j - i + 1, ...out)
    }
  })
}

export function tokenizer() {
  const md = new MarkdownIt('commonmark', { html: true, linkify: false }).enable(['table', 'strikethrough']).use(markPlugin).use(wikilinks).use(reshape)
  return md
}

const listIsOrdered = (tok: Token) => ({ start: Number(tok.attrGet('start') ?? 1) })

export function parser(schema: Schema) {
  return new MarkdownParser(schema, tokenizer(), {
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'listItem' },
    bullet_list: { block: 'bulletList' },
    ordered_list: { block: 'orderedList', getAttrs: listIsOrdered },
    task_list: { block: 'taskList' },
    task_item: { block: 'taskItem', getAttrs: (tok) => ({ checked: !!tok.meta?.checked }) },
    heading: { block: 'heading', getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
    code_block: { block: 'codeBlock', noCloseToken: true },
    fence: { block: 'codeBlock', getAttrs: (tok) => ({ language: tok.info.trim() || null }), noCloseToken: true },
    hr: { node: 'horizontalRule' },
    image: { node: 'image', getAttrs: (tok) => ({ src: tok.attrGet('src'), title: tok.attrGet('title') || null, alt: tok.children?.[0]?.content || null }) },
    hardbreak: { node: 'hardBreak' },
    // A single line break inside a paragraph shows as a break, as in Obsidian, and is written back as one.
    softbreak: { node: 'hardBreak', getAttrs: () => ({ soft: true }) },
    html_block: { node: 'rawBlock', getAttrs: (tok) => ({ text: tok.content.replace(/\n$/, '') }) },
    raw_inline: { node: 'rawInline', getAttrs: (tok) => ({ text: tok.content }) },
    wikilink: { node: 'pageLink', getAttrs: (tok) => ({ target: tok.meta.target, label: tok.meta.label }) },
    table: { block: 'table' },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: 'tableRow' },
    th: { block: 'tableHeader' },
    td: { block: 'tableCell' },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    mark: { mark: 'highlight' },
    u: { mark: 'underline' },
    link: { mark: 'link', getAttrs: (tok) => ({ href: tok.attrGet('href'), title: tok.attrGet('title') || null }) },
    code_inline: { mark: 'code', noCloseToken: true },
  })
}

/** What a document was read from: the source of each top-level block, by the block itself. */
export interface Source {
  /** Anything before the first block (blank lines). */
  prefix: string
  blocks: Map<PMNode, string>
  /** The block that ended the file. */
  last: PMNode | null
}

export function parseMarkdown(schema: Schema, text: string): { doc: PMNode; source: Source } {
  const md = tokenizer()
  const tokens = md.parse(text, {})
  const doc = parser(schema).parse(text)
  const lines = text.split('\n')
  // Top-level blocks, in order, with the line each starts on.
  const starts = tokens.filter((t) => t.level === 0 && t.nesting >= 0 && t.block && t.map).map((t) => t.map![0])
  const blocks = new Map<PMNode, string>()
  let prefix = ''
  if (starts.length === doc.childCount) {
    prefix = lines
      .slice(0, starts[0] ?? 0)
      .map((l) => l + '\n')
      .join('')
    doc.forEach((child, _o, i) => {
      // Each block owns its lines and the blank lines (or reference definitions) after it.
      const from = starts[i]
      const to = i + 1 < starts.length ? starts[i + 1] : lines.length
      blocks.set(child, lines.slice(from, to).join('\n') + (to < lines.length ? '\n' : ''))
    })
  }
  return { doc, source: { prefix: starts.length === doc.childCount ? prefix : '', blocks, last: blocks.size ? doc.lastChild : null } }
}

// ---- Writing ------------------------------------------------------------------------------

const mark = (open: string, close = open) => ({ open, close, mixable: true, expelEnclosingWhitespace: true })

/** A table cell, written as one line: its paragraphs joined, pipes escaped. */
function cellText(cell: PMNode) {
  return (
    serializer
      .serialize(cell, { tightLists: true })
      .replace(/\n+/g, ' ')
      .replace(/\|/g, '\\|')
      .trim() || ' '
  )
}

export const serializer = new MarkdownSerializer(
  {
    blockquote: (state, node) => state.wrapBlock('> ', null, node, () => state.renderContent(node)),
    codeBlock: (state, node) => {
      const text = node.textContent
      const fence = text.match(/`{3,}/gm) ? '`'.repeat(Math.max(...text.match(/`{3,}/gm)!.map((f) => f.length)) + 1) : '```'
      state.write(fence + (node.attrs.language || '') + '\n')
      state.text(text, false)
      state.ensureNewLine()
      state.write(fence)
      state.closeBlock(node)
    },
    heading: (state, node) => {
      state.write('#'.repeat(node.attrs.level) + ' ')
      state.renderInline(node, false)
      state.closeBlock(node)
    },
    horizontalRule: (state, node) => {
      state.write('---')
      state.closeBlock(node)
    },
    bulletList: (state, node) => state.renderList(node, '  ', () => '- '),
    orderedList: (state, node) => {
      const start = node.attrs.start || 1
      const width = String(start + node.childCount - 1).length
      state.renderList(node, ' '.repeat(width + 2), (i) => `${start + i}.`.padEnd(width + 2, ' '))
    },
    taskList: (state, node) => state.renderList(node, '  ', () => '- '),
    listItem: (state, node) => state.renderContent(node),
    taskItem: (state, node) => {
      state.write(node.attrs.checked ? '[x] ' : '[ ] ')
      state.renderContent(node)
    },
    paragraph: (state, node) => {
      state.renderInline(node)
      state.closeBlock(node)
    },
    image: (state, node) => {
      const alt = state.esc(node.attrs.alt || '')
      const src = String(node.attrs.src || '').replace(/[()\s]/g, (c) => encodeURIComponent(c))
      state.write(`![${alt}](${src}${node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : ''})`)
    },
    hardBreak: (state, node, parent, index) => {
      // Not at the very end of a paragraph, where it would mean nothing.
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write(node.attrs.soft ? '\n' : '\\\n')
          return
        }
      }
    },
    text: (state, node) => state.text(node.text ?? '', !(state as unknown as { inAutolink?: boolean }).inAutolink),
    pageLink: (state, node) => state.write(`[[${node.attrs.target}${node.attrs.label ? '|' + node.attrs.label : ''}]]`),
    rawBlock: (state, node) => {
      state.write(node.attrs.text)
      state.closeBlock(node)
    },
    rawInline: (state, node) => state.write(node.attrs.text),
    table: (state, node) => {
      const rows: string[][] = []
      node.forEach((row) => {
        const cells: string[] = []
        row.forEach((cell) => cells.push(cellText(cell)))
        rows.push(cells)
      })
      const cols = Math.max(...rows.map((r) => r.length))
      const line = (cells: string[]) => '| ' + Array.from({ length: cols }, (_, i) => cells[i] ?? ' ').join(' | ') + ' |'
      state.write(line(rows[0] ?? []) + '\n')
      state.write('| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |')
      for (const r of rows.slice(1)) state.write('\n' + line(r))
      state.closeBlock(node)
    },
    tableRow: () => {},
    tableHeader: () => {},
    tableCell: () => {},
  },
  {
    italic: mark('*'),
    bold: mark('**'),
    strike: mark('~~'),
    highlight: mark('=='),
    underline: mark('<u>', '</u>'),
    code: defaultMarkdownSerializer.marks.code,
    link: defaultMarkdownSerializer.marks.link,
  },
)

/** The document as Markdown: untouched blocks exactly as they were read, edited ones written fresh. */
export function serializeMarkdown(doc: PMNode, source?: Source): string {
  let out = source?.prefix ?? ''
  const n = doc.childCount
  doc.forEach((child, _o, i) => {
    const original = source?.blocks.get(child)
    if (original !== undefined) {
      out += original
      return
    }
    const text = serializer.serialize(doc.type.create(null, child), { tightLists: true }).replace(/\n+$/, '')
    // An empty paragraph is just space on the page: Markdown has no way to write one.
    if (!text.trim()) return
    // A block written fresh sits after a blank line, so it can't run into the one before.
    out = out.trim() ? out.replace(/\n*$/, '\n\n') : ''
    out += text
    if (i < n - 1) out += '\n\n'
  })
  // Untouched to the end (an empty line to type on doesn't count): the file ends as it did.
  // Otherwise, with one newline.
  let last = doc.lastChild
  for (let i = n - 1; i >= 0 && last?.type.name === 'paragraph' && !last.content.size; i--) last = i > 0 ? doc.child(i - 1) : null
  if (!(source && last && last === source.last)) out = out.replace(/\n*$/, '') + (out.trim() ? '\n' : '')
  return out
}
