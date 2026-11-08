// Getting a piece out of Ekdanta: the shared, pure part of export. Shared by the app (copying, printing)
// and the server (.docx, HTML, clean Markdown), so no DOM or Node here.
//
// prepare() turns a file into plain Markdown any engine can read: Ekdanta's own front matter goes
// (title, author and date are kept apart, as document properties), [[links]] become their labels,
// template prompts are dropped, raw HTML becomes text and image paths are resolved. The source is
// never changed. toText() and toHtml() then make LinkedIn-ready text, plain text or HTML from it.
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import markPlugin from 'markdown-it-mark'
import { tokenizer } from '../editor/markdown.ts'
import { splitFrontMatter } from './frontmatter.ts'
import { slug } from './slug.ts'
import { isPromptParagraph } from './special.ts'

export type ExportFormat = 'docx' | 'pdf' | 'html' | 'md' | 'linkedin' | 'plain' | 'rich'

export interface Prepared {
  title: string
  author: string
  date: string
  /** Plain Markdown: no front matter, no [[links]], no prompts, no raw HTML (only <u> for underline). */
  body: string
  /** Things the writer should know about, as short sentences. */
  warnings: string[]
  /** What the export left as written; each engine says what that means for it (see syntaxWarnings). */
  counts: { footnotes: number; citations: number }
}

export interface PrepareOptions {
  /** The page a [[link]] names: its title and vault path, or null if there's no such page. */
  page: (target: string) => { title: string; path: string } | null
  /** How a link to a page that exists is written: as its label, or as a Markdown link to this path. */
  link?: (page: { title: string; path: string }) => string | null
  /** An image's src as the export should write it, or a warning and no src if it can't be used. */
  image?: (src: string) => { src?: string; warning?: string }
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/** Split a line into code spans (left alone) and the text between them. */
function outsideCode(line: string, fn: (text: string) => string) {
  return line
    .split(/(`+)([\s\S]*?[^`])\1(?!`)/)
    .map((part, i, all) => {
      // split with two groups: [text, fence, code, text, fence, code, …]
      if (i % 3 === 0) return fn(part)
      if (i % 3 === 1) return part + all[i + 1] + part
      return ''
    })
    .join('')
}

const WIKI = /(!?)\[\[([^\]\n[]+)\]\]/g
const TAG = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g

/** Prepare a document's Markdown for export. `content` is the whole file, front matter and all. */
export function prepare(content: string, opts: PrepareOptions): Prepared {
  const { meta, body } = splitFrontMatter(content.replace(/\r\n?/g, '\n'))
  const warnings: string[] = []
  const lines = body.split('\n')
  // What to do with each line, from the block it belongs to.
  const drop = new Set<number>()
  const code = new Set<number>()
  const html = new Set<number>()
  let htmlBlocks = 0
  let htmlTags = 0
  // The link reference definitions, for images written as ![alt][ref].
  const env: { references?: References } = {}
  for (const t of tokenizer().parse(body, env)) {
    if (!t.map) continue
    const [from, to] = t.map
    if (t.type === 'fence' || t.type === 'code_block') for (let i = from; i < to; i++) code.add(i)
    else if (t.type === 'html_block') {
      // A comment is a note to whoever edits the file, not part of the piece.
      if (/^\s*<!--[\s\S]*-->\s*$/.test(t.content)) for (let i = from; i < to; i++) drop.add(i)
      else {
        htmlBlocks++
        for (let i = from; i < to; i++) html.add(i)
      }
    } else if (t.type === 'paragraph_open' && t.level === 0) {
      // A template's writing prompt is guidance, not the writer's words.
      if (isPromptParagraph(lines.slice(from, to).join('\n'))) for (let i = from; i < to; i++) drop.add(i)
    }
  }
  // The lines of each paragraph, heading or table row, read as one: a tag or a code span can run over
  // a line break, and read line by line `<img\nsrc=x onerror=…>` would never be seen as a tag.
  const blockOf = new Array<number>(lines.length).fill(-1)
  for (const t of tokenizer().parse(body, {})) {
    if (t.type !== 'inline' || !t.map) continue
    const [from, to] = t.map
    for (let i = from; i < to; i++) if (blockOf[i] === -1 && !drop.has(i) && !code.has(i) && !html.has(i)) blockOf[i] = from
  }

  const missing = new Set<string>()
  const image = (alt: string, src: string, title = ''): string => {
    const r = opts.image ? opts.image(src) : { src }
    if (r.warning) missing.add(r.warning)
    if (!r.src) return ''
    const out = /[\s()<>\\]/.test(r.src) ? `<${r.src.replace(/[<>\\]/g, '\\$&')}>` : r.src
    // An image in the alt text is an image too.
    return `![${images(alt, env.references, image)}](${out}${title ? ` "${title.replace(/["\\]/g, '\\$&')}"` : ''})`
  }
  const wiki = (_m: string, bang: string, inner: string) => {
    const [target, label] = inner.split('|')
    const name = target.split('#')[0].trim()
    // ![[picture.png]] embeds an image, as in Obsidian.
    if (bang && /\.[a-z0-9]+$/i.test(name)) return image(label?.trim() ?? '', name)
    const page = name ? opts.page(name) : null
    const text = label?.trim() || page?.title || target.replace(/#/, ' › ').trim()
    const href = page && opts.link ? opts.link(page) : null
    return href ? `[${escapeLabel(text)}](${/[\s()]/.test(href) ? `<${href}>` : href})` : escapeText(text)
  }

  const out: string[] = []
  let footnotes = 0
  let citations = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (drop.has(i)) continue
    if (code.has(i)) {
      out.push(line)
      continue
    }
    if (html.has(i)) {
      // Shown as the text it is, so nothing the writer wrote silently disappears.
      out.push(line.replace(/</g, '\\<'))
      continue
    }
    // A block's lines go through together; a line outside any block goes through alone.
    let end = i + 1
    if (blockOf[i] !== -1) while (end < lines.length && blockOf[end] === blockOf[i]) end++
    const chunk = lines.slice(i, end).join('\n')
    i = end - 1
    // Links and images are set aside while raw HTML is looked for, so `<a path.png>` isn't taken for a tag.
    // Images go first, over the whole block: a code span can sit in an image's alt text.
    const kept: string[] = []
    const keep = (s: string) => `\u0001${kept.push(s) - 1}\u0001`
    out.push(
      outsideCode(
        images(chunk, env.references, (alt, src, title) => keep(image(alt, src, title))),
        (text) => {
          footnotes += (text.match(/\[\^[^\]\s]+\](?!:)/g) ?? []).length
          citations += (text.match(/\[[^\]]*-?@[\w:.#$%&+?<>~/-]+[^\]]*\]/g) ?? []).length
          return text
            .replace(WIKI, (...m: string[]) => keep(wiki(m[0], m[1], m[2])))
            .replace(TAG, (tag) => {
              if (/^<\/?u>$/i.test(tag)) return tag
              if (tag.startsWith('<!--')) return ''
              htmlTags++
              return tag.replace(/</g, '\\<')
            })
        },
      ).replace(/\u0001(\d+)\u0001/g, (_m, k: string) => kept[Number(k)]),
    )
  }
  if (htmlBlocks) warnings.push(`${plural(htmlBlocks, 'HTML block')} exported as text`)
  if (htmlTags) warnings.push(`${plural(htmlTags, 'HTML tag')} exported as text`)
  warnings.push(...missing)

  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return {
    title: (meta.title ?? '').trim(),
    author: (meta.author ?? '').trim(),
    date: (meta.date ?? '').trim(),
    body: text ? text + '\n' : '',
    warnings,
    counts: { footnotes, citations },
  }
}

type References = Record<string, { href: string; title: string }>
const {
  helpers,
  utils: { normalizeReference },
} = new MarkdownIt()

/**
 * Every image in `text`, found as markdown-it finds them: inline or by reference (`![a][ref]`,
 * `![a][]`, `![a]`), with a title in "quotes", 'quotes' or (parentheses), and a destination that may
 * be in <angle brackets> or hold balanced parentheses. Each is replaced by what `fn` makes of its alt
 * (as written), destination and title (both unescaped). Code spans and escaped characters are passed
 * over. Nothing an engine would read as an image can get past this to the engine unchecked.
 */
function images(text: string, refs: References | undefined, fn: (alt: string, src: string, title: string) => string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      out += text.slice(i, i + 2)
      i += 2
    } else if (c === '`') {
      const end = codeSpanEnd(text, i)
      out += text.slice(i, end)
      i = end
    } else if (c === '!' && text[i + 1] === '[') {
      const img = imageAt(text, i, refs)
      if (img) {
        out += fn(img.alt, img.src, img.title)
        i = img.end
      } else {
        out += '!['
        i += 2
      }
    } else {
      out += c
      i++
    }
  }
  return out
}

/** The end of the code span or backtick run at `i`; a run with no closing run is plain backticks. */
function codeSpanEnd(text: string, i: number) {
  const runEnd = (from: number) => {
    let n = from
    while (text[n] === '`') n++
    return n
  }
  const open = runEnd(i)
  for (let j = text.indexOf('`', open); j >= 0;) {
    const end = runEnd(j)
    if (end - j === open - i) return end
    j = text.indexOf('`', end)
  }
  return open
}

/** Where the link label opened just before `from` closes (the index of its `]`), or -1. */
function labelEnd(text: string, from: number) {
  let level = 1
  for (let i = from; i < text.length;) {
    const c = text[i]
    if (c === '\\') i += 2
    else if (c === '`') i = codeSpanEnd(text, i)
    else {
      if (c === '[') level++
      else if (c === ']' && --level === 0) return i
      i++
    }
  }
  return -1
}

/** The image that starts with the `![` at `i`, as markdown-it's image rule reads it, or null if it isn't one. */
function imageAt(text: string, i: number, refs: References | undefined): { alt: string; src: string; title: string; end: number } | null {
  const close = labelEnd(text, i + 2)
  if (close < 0) return null
  const alt = text.slice(i + 2, close)
  const ws = (p: number) => {
    while (p < text.length && /[ \t\n]/.test(text[p])) p++
    return p
  }
  let pos = close + 1
  if (text[pos] === '(') {
    pos = ws(pos + 1)
    let src = ''
    const dest = helpers.parseLinkDestination(text, pos, text.length)
    if (dest.ok) {
      src = dest.str
      pos = dest.pos
    }
    const before = pos
    pos = ws(pos)
    let title = ''
    const t = helpers.parseLinkTitle(text, pos, text.length)
    if (pos > before && t.ok) {
      title = t.str
      pos = ws(t.pos)
    }
    return text[pos] === ')' ? { alt, src, title, end: pos + 1 } : null
  }
  let label = ''
  if (text[pos] === '[') {
    const end = labelEnd(text, pos + 1)
    if (end >= 0) {
      label = text.slice(pos + 1, end)
      pos = end + 1
    }
  }
  const ref = refs?.[normalizeReference(label || alt)]
  return ref ? { alt, src: ref.href, title: ref.title, end: pos } : null
}

/**
 * What an export without footnotes or citations says about them. Pandoc makes footnotes and leaves
 * citations; the built-in Word engine leaves both, and says pandoc would make the footnotes; HTML,
 * PDF and the copies (`as-written`) leave both as written. Clean Markdown keeps them as Markdown.
 */
export function syntaxWarnings(counts: Prepared['counts'], engine: 'pandoc' | 'built-in' | 'as-written' | 'markdown'): string[] {
  if (engine === 'markdown') return []
  const w: string[] = []
  if (counts.footnotes && engine !== 'pandoc') w.push(`${plural(counts.footnotes, 'footnote mark')} like [^1] exported as written${engine === 'built-in' ? ' (pandoc turns them into footnotes)' : ''}`)
  if (counts.citations) w.push(`${plural(counts.citations, 'citation')} like [@key] exported as written`)
  return w
}

const escapeText = (s: string) => s.replace(/([\\`*_[\]<>#|~=])/g, '\\$1')
const escapeLabel = (s: string) => s.replace(/([\\[\]])/g, '\\$1')

/** Clean Markdown: front matter reduced to title and date, then the prepared body. */
export function toMarkdown(p: Prepared): string {
  const fm = [p.title && `title: ${yaml(p.title)}`, p.date && `date: ${yaml(p.date)}`].filter(Boolean)
  return (fm.length ? `---\n${fm.join('\n')}\n---\n\n` : '') + p.body
}
const yaml = (v: string) => (/^[\w][\w .,'’!?()-]*$/.test(v) && !/:\s/.test(v) ? v : JSON.stringify(v))

// ---- Text for pasting -------------------------------------------------------------------------

export const LINKEDIN_LIMIT = 3000

/** Characters as a reader counts them: an emoji or a 𝗯𝗼𝗹𝗱 letter is one. */
export const charCount = (s: string) => Array.from(s).length

const BOLD: [number, number, number][] = [
  [0x41, 0x5a, 0x1d5d4], // A–Z → 𝗔–𝗭 (sans-serif bold)
  [0x61, 0x7a, 0x1d5ee], // a–z
  [0x30, 0x39, 0x1d7ec], // 0–9
]
/** Latin letters and digits in Unicode sans-serif bold, which survives pasting where formatting doesn't. Accented letters stay as they are. */
export function unicodeBold(s: string): string {
  return Array.from(s)
    .map((c) => {
      const n = c.codePointAt(0)!
      const r = BOLD.find(([a, z]) => n >= a && n <= z)
      return r ? String.fromCodePoint(r[2] + n - r[0]) : c
    })
    .join('')
}

export interface TextOptions {
  /** 'linkedin': • bullets, quotes in quotation marks. 'plain': - bullets, > quotes. */
  style: 'linkedin' | 'plain'
  /** Bold and headings in Unicode bold (LinkedIn has no formatting of its own). */
  bold?: boolean
}

/**
 * The prepared body as text that pastes cleanly: paragraphs apart with a blank line, headings on
 * their own lines, bullets, links as "label (url)". Images can't be pasted as text and are left out.
 */
export function toText(body: string, opts: TextOptions): { text: string; warnings: string[] } {
  const tokens = tokenizer().parse(body, {})
  const blocks: string[] = []
  let images = 0
  let tables = 0
  const bullet = opts.style === 'linkedin' ? '• ' : '- '

  const inline = (t: Token | undefined, bold = false): string => {
    let out = ''
    let strong = 0
    const links: { at: number; url: string }[] = []
    for (const c of t?.children ?? []) {
      switch (c.type) {
        case 'text':
        case 'code_inline':
        case 'raw_inline':
          out += opts.bold && (bold || strong > 0) ? unicodeBold(c.content) : c.content
          break
        case 'softbreak':
        case 'hardbreak':
          out += '\n'
          break
        case 'strong_open':
          strong++
          break
        case 'strong_close':
          strong--
          break
        case 'link_open':
          links.push({ at: out.length, url: c.attrGet('href') ?? '' })
          break
        case 'link_close': {
          const link = links.pop()
          if (!link) break
          const label = out.slice(link.at)
          const url = link.url.replace(/^mailto:/i, '')
          // A bare URL needs no repeat; a link to a page in the vault has no address to give.
          if (/^([a-z][\w+.-]*:)/i.test(link.url) && url !== label && link.url !== label) out += ` (${url})`
          break
        }
        case 'image':
          images++
          break
      }
    }
    return out
  }

  const walk = (from: number, to: number, depth: number, out: string[]) => {
    for (let i = from; i < to; i++) {
      const t = tokens[i]
      switch (t.type) {
        case 'heading_open': {
          out.push(inline(tokens[i + 1], true))
          i += 2
          break
        }
        case 'paragraph_open': {
          const text = inline(tokens[i + 1])
          if (text.trim()) out.push(text)
          i += 2
          break
        }
        case 'bullet_list_open':
        case 'ordered_list_open':
        case 'task_list_open': {
          const close = matching(tokens, i)
          const items: string[] = []
          let n = Number(t.attrGet('start') ?? 1)
          for (let j = i + 1; j < close; j++) {
            const it = tokens[j]
            if (it.type !== 'list_item_open' && it.type !== 'task_item_open') continue
            const end = matching(tokens, j)
            const parts: string[] = []
            walk(j + 1, end, depth + 1, parts)
            const mark = t.type === 'ordered_list_open' ? `${n++}. ` : t.type === 'task_list_open' ? (it.meta?.checked ? '☑ ' : '☐ ') : bullet
            const indent = '   '.repeat(depth)
            const [first = '', ...rest] = parts
            items.push(indent + mark + first.replace(/\n/g, '\n' + indent + '  ') + rest.map((r) => '\n' + r).join(''))
            j = end
          }
          // Nested lists hang under their item; a top-level list is one block.
          out.push(items.join('\n'))
          i = close
          break
        }
        case 'blockquote_open': {
          const close = matching(tokens, i)
          const parts: string[] = []
          walk(i + 1, close, depth, parts)
          const text = parts.join('\n\n')
          out.push(opts.style === 'linkedin' ? `“${text}”` : text.replace(/^/gm, '> '))
          i = close
          break
        }
        case 'fence':
        case 'code_block':
          out.push(t.content.replace(/\n$/, ''))
          break
        case 'hr':
          out.push(opts.style === 'linkedin' ? '———' : '---')
          break
        case 'table_open': {
          tables++
          const close = matching(tokens, i)
          const rows: string[] = []
          let cells: string[] = []
          for (let j = i + 1; j < close; j++) {
            if (tokens[j].type === 'tr_open') cells = []
            else if (tokens[j].type === 'inline') cells.push(inline(tokens[j]).trim())
            else if (tokens[j].type === 'tr_close') rows.push(cells.join(' | '))
          }
          out.push(rows.join('\n'))
          i = close
          break
        }
        case 'html_block':
          out.push(t.content.replace(/\n$/, ''))
          break
      }
    }
  }

  walk(0, tokens.length, 0, blocks)
  const warnings: string[] = []
  if (images) warnings.push(`${plural(images, 'image')} left out: text can't carry pictures`)
  if (tables) warnings.push(`${plural(tables, 'table')} flattened into lines`)
  return { text: blocks.join('\n\n').trim(), warnings }
}

/** The token that closes the one at `i` (a list, an item, a quote, a table). */
function matching(tokens: Token[], i: number) {
  const open = tokens[i]
  const closeType = open.type.replace(/_open$/, '_close')
  for (let j = i + 1; j < tokens.length; j++) if (tokens[j].type === closeType && tokens[j].level === open.level) return j
  return tokens.length
}

// ---- HTML -------------------------------------------------------------------------------------

/** <u> and </u>, the one tag prepare() keeps. */
const U_TAG = /^<(\/?)u>/i

/**
 * The prepared body as an HTML fragment. A single line break shows as a break, as on the page.
 * Raw HTML is never passed through, whatever prepare() missed: it goes into the app's own page when
 * printing and into files and the clipboard, so a note from someone else must not carry a script.
 * Only <u> is let through, as itself.
 */
export function toHtml(body: string): string {
  const md = new MarkdownIt('commonmark', { html: false, breaks: true }).enable(['table', 'strikethrough']).use(markPlugin)
  md.inline.ruler.before('html_inline', 'underline_tag', (state, silent) => {
    const m = U_TAG.exec(state.src.slice(state.pos, state.pos + 4))
    if (!m) return false
    if (!silent) state.push('html_inline', '', 0).content = m[1] ? '</u>' : '<u>'
    state.pos += m[0].length
    return true
  })
  return md
    .render(body)
    .replace(/<li>(<p>)?\[ \] /g, '<li class="task">$1☐ ')
    .replace(/<li>(<p>)?\[[xX]\] /g, '<li class="task">$1☑ ')
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A standalone HTML file: the title, author and date, the piece, and its own styles. */
export function htmlDocument(p: Prepared): string {
  const byline = [p.author, p.date].filter(Boolean).map(escHtml).join(' · ')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(p.title || 'Untitled')}</title>
${p.author ? `<meta name="author" content="${escHtml(p.author)}">\n` : ''}<style>
${EXPORT_CSS}
</style>
</head>
<body>
<article>
${p.title ? `<h1 class="title">${escHtml(p.title)}</h1>\n` : ''}${byline ? `<p class="byline">${byline}</p>\n` : ''}${toHtml(p.body)}</article>
</body>
</html>
`
}

/** The look of an exported page: a readable serif column, light or dark as the reader's system is. */
export const EXPORT_CSS = `:root { color-scheme: light dark; --ink: #1f1e1c; --muted: #6f6b64; --line: #e5e3df; --bg: #fafaf9; --code: #f1efeb; --mark: rgba(246, 205, 70, 0.42); --link: #2f4f8f; }
@media (prefers-color-scheme: dark) { :root { --ink: #e9e6e0; --muted: #a39f97; --line: #3a3835; --bg: #1f1e1d; --code: #2c2a28; --mark: rgba(205, 160, 40, 0.34); --link: #8ea9e0; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 18px/1.65 'Newsreader', 'Iowan Old Style', Georgia, serif; }
article { max-width: 640px; margin: 0 auto; padding: 56px 16px 80px; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.5em; font-weight: 600; }
h1.title { font-size: 2em; margin-top: 0; }
.byline { color: var(--muted); margin-top: -0.4em; }
a { color: var(--link); }
img { max-width: 100%; height: auto; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid var(--line); color: var(--muted); }
code { font: 0.85em ui-monospace, Menlo, monospace; background: var(--code); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--code); padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
mark { background: var(--mark); color: inherit; }
table { border-collapse: collapse; margin: 1em 0; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
li.task { list-style: none; margin-left: -1.2em; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
@media print { body { background: none; color: #000; } article { padding: 0; } }`

// ---- File names -------------------------------------------------------------------------------

/** An export's file name, from the title, by the same Unicode-safe rule as documents: "Café / Notes" → "cafe-notes.docx". */
export function exportName(title: string, ext: string, fallback = 'export'): string {
  const name = slug(title, 80) || slug(fallback, 80) || 'export'
  return ext ? `${name}.${ext}` : name
}

/** A document's title for export: its front-matter title, else its file name. */
export const docTitle = (p: Prepared, path: string) => p.title || (path.split('/').pop() ?? '').replace(/\.md$/, '')

// ---- Formats ----------------------------------------------------------------------------------

export const FORMATS: { id: ExportFormat; label: string; note: string; ext?: string }[] = [
  { id: 'docx', label: 'Word (.docx)', note: 'For handing in or sharing for comments', ext: 'docx' },
  { id: 'pdf', label: 'PDF', note: 'Opens the print dialog: choose Save as PDF' },
  { id: 'html', label: 'HTML', note: 'One web page with its images and styles inside', ext: 'html' },
  { id: 'md', label: 'Markdown (clean)', note: 'Links resolved, prompts and Ekdanta’s notes left out', ext: 'md' },
  { id: 'linkedin', label: 'Copy for LinkedIn', note: 'Plain text with • bullets and blank lines between paragraphs' },
  { id: 'plain', label: 'Copy as plain text', note: 'No formatting at all' },
  { id: 'rich', label: 'Copy as rich text', note: 'For Google Docs, Notion or email' },
]

/** The format a kind of writing starts on: Copy for LinkedIn for LinkedIn pieces, Word for the rest. */
export function defaultFormat(kind: { id: string; name?: string } | null | undefined): ExportFormat {
  return kind && /linkedin/i.test(`${kind.id} ${kind.name ?? ''}`) ? 'linkedin' : 'docx'
}
