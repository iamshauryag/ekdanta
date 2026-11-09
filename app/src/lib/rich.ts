// Formatting in the assistant's proposals.
//
// The model reads the draft as the writer sees it: plain text, without the `**` or `#` of the file. When
// the writer asks for formatting ("make the key phrases bold", "turn this into a list"), the model writes
// the change in Markdown. A change like that must go into the page as formatting, never as stars: it is
// marked as one (`format`), kept whole (the `**` on each side of a phrase is one change, not two), and the
// page applies it as bold, headings and lists when it is accepted (editor/format.ts).
//
// Only what the model added is read as Markdown. The writer's own text in the change stays exactly as it
// reads on the page: "2*3*4", "1990. A good year" and "# not a heading" are text, never italics, a list
// or a heading. So a change is first made safe (safeMarkdown): every character the model kept from the
// draft is escaped, and only the characters it put in can format.
//
// What formatting may come in is limited too (formatProblem in assistant.ts): inline marks, and headings or
// lists only when the writer asked for them. Never images, raw HTML, rules, tables or code blocks.
import { diffChars } from 'diff'
import { tokenizer } from '../editor/markdown.ts'

let md: ReturnType<typeof tokenizer> | null = null
const tokens = (s: string) => (md ??= tokenizer()).parse(s, {})

/** Markdown's punctuation, which a backslash makes plain text. */
const escapeText = (s: string) => s.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '\\$&')

/**
 * The model's change as Markdown in which only what it added can format: the characters it kept from
 * `find` (the draft's text, as the page shows it) are escaped. Inside a code span the model opened, they are
 * left as they are, since a backslash there is shown as typed: `foo.bar()` stays foo.bar(). `find` read
 * this way is `find` itself.
 */
export function safeMarkdown(find: string, replace: string): string {
  let out = ''
  // The backtick run that opened the code span the model is in, if any.
  let code = 0
  for (const part of diffChars(find, replace)) {
    if (part.removed) continue
    if (!part.added) {
      out += code ? part.value : escapeText(part.value)
      continue
    }
    out += part.value
    for (const run of part.value.match(/`+/g) ?? []) {
      if (!code) code = run.length
      else if (run.length === code) code = 0
    }
  }
  return out
}

/** Markdown as the page shows it: paragraphs, headings and list items separated by a blank line, a line break as a newline. */
export function plainOf(markdown: string): string {
  const blocks: string[] = []
  for (const t of tokens(markdown)) {
    if (t.type === 'code_block' || t.type === 'fence') blocks.push(t.content.replace(/\n$/, ''))
    if (t.type !== 'inline') continue
    let s = ''
    for (const c of t.children ?? []) {
      if (c.type === 'text' || c.type === 'code_inline' || c.type === 'raw_inline' || c.type === 'html_inline') s += c.content
      else if (c.type === 'softbreak' || c.type === 'hardbreak') s += '\n'
      else if (c.type === 'wikilink') s += c.meta?.label || c.meta?.target || ''
    }
    blocks.push(s)
  }
  return blocks.join('\n\n')
}

/** Everything a piece of Markdown makes, beyond plain paragraphs of text: "h2 strong_open bullet_list_open…", in order. */
export function shapeOf(markdown: string): string {
  return kindsOf(markdown).join(' ')
}

/** The kinds of formatting a piece of Markdown makes, in order. */
export function kindsOf(markdown: string): string[] {
  const out: string[] = []
  for (const t of tokens(markdown)) {
    if (t.type === 'inline') {
      for (const c of t.children ?? []) if (c.nesting === 1 || ['code_inline', 'image', 'wikilink', 'html_inline', 'raw_inline'].includes(c.type)) out.push(c.type)
    } else if (t.nesting === 1 && t.type !== 'paragraph_open') out.push(t.type === 'heading_open' ? t.tag : t.type)
    else if (t.nesting === 0 && t.type !== 'inline') out.push(t.type)
  }
  return out
}

/** Does turning `find` (the draft's text, as the page shows it) into `replace` format it? Only when what the model added formats. */
export const formats = (find: string, replace: string) => /[*_#>`~=[\-+\d<!|]/.test(replace) && kindsOf(safeMarkdown(find, replace)).length > 0

/** Inline formatting a proposal may carry: bold, italics, links, inline code, strikethrough, highlight. */
export const INLINE_KINDS = new Set(['strong_open', 'em_open', 'link_open', 'code_inline', 's_open', 'mark_open', 'u_open'])
/** Blocks a proposal may make, when the writer asked for headings or lists. */
export const BLOCK_KINDS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'bullet_list_open', 'ordered_list_open', 'list_item_open'])
