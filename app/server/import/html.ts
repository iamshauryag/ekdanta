// HTML to Markdown. A saved web page goes through Readability first, which keeps the article and
// drops the site around it (navigation, footers, share bars); HTML made from a document (a .docx,
// an .rtf) is already all content and skips that step. Then sanitise, then Turndown.
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { sanitizeHtml, type Media } from './sanitize.ts'

export interface Converted {
  markdown: string
  media: Media[]
  /** A title the source names itself (a page's <title>, a document's properties). */
  title?: string
  /** When the source says it was written, as YYYY-MM-DD. */
  created?: string
  /** Anything the writer should know about the conversion. A note makes the row "Needs review". */
  notes: string[]
}

export function turndown() {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**', hr: '---' })
  td.use(gfm)
  // Turndown checks the rules added last first, so this wins over the GFM tables rule: a table with merged cells can't be a Markdown table, so it stays HTML.
  td.addRule('mergedTable', {
    filter: (node) => node.nodeName === 'TABLE' && (node as HTMLElement).getAttribute('data-merged') === 'true',
    replacement: (_content, node) => {
      const el = node as HTMLElement
      el.removeAttribute('data-merged')
      return `\n\n${el.outerHTML.replace(/\n\s*\n/g, '\n')}\n\n`
    },
  })
  // A line break inside a Markdown table cell has to be <br>: a real newline would end the row.
  td.addRule('cellBreak', {
    filter: (node) => node.nodeName === 'BR' && !!(node as HTMLElement).closest?.('td, th'),
    replacement: () => '<br>',
  })
  // Images keep their alt text and lose any title noise.
  td.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const src = el.getAttribute('src') ?? ''
      return src ? `![${(el.getAttribute('alt') ?? '').replace(/[[\]\n]/g, ' ').trim()}](${src.replace(/ /g, '%20').replace(/\)/g, '%29')})` : ''
    },
  })
  return td
}

/** Clean Markdown from HTML. `article`: run Readability first (a saved web page). */
export function htmlToMarkdown(html: string, opts: { article?: boolean; prefix?: string } = {}): Converted {
  const notes: string[] = []
  const head = parseHTML(html.includes('<html') || html.includes('<body') ? html : `<!doctype html><html><head></head><body>${html}</body></html>`).document
  const pageTitle = head.querySelector('title')?.textContent?.trim() || undefined
  const created = dateOf(
    head.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ??
      head.querySelector('meta[name="date"]')?.getAttribute('content') ??
      head.querySelector('time[datetime]')?.getAttribute('datetime') ??
      undefined,
  )
  let content = html
  let title = pageTitle
  const h1 = head.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim()
  if (opts.article) {
    // Site navigation is never part of the article. Readability drops it from a full page, but not
    // reliably from a short one, so it goes first — and the whole-page fallback below starts from the
    // same cleaned page rather than the original.
    for (const el of [...head.querySelectorAll('nav, [role="navigation"]')]) el.remove()
    content = head.body?.innerHTML ?? content
    // Measured before Readability, which rewrites the document it is given.
    const full = head.body?.textContent?.trim().length ?? 0
    let article: { title?: string | null; content?: string | null; textContent?: string | null } | null = null
    try {
      article = new Readability(head as unknown as Document, { keepClasses: false }).parse()
    } catch {
      article = null
    }
    if (article?.content && (article.textContent?.trim().length ?? 0) > Math.min(200, full * 0.25)) {
      content = article.content
      title = article.title?.trim() || pageTitle
      // "Slow Mornings - The Blog": the page's own heading is the better title.
      if (h1 && title && title !== h1 && title.startsWith(h1)) title = h1
    } else notes.push('Couldn’t find the main article, so the whole page was kept')
  }
  const clean = sanitizeHtml(content, opts.prefix)
  if (clean.mergedTables) notes.push(`${clean.mergedTables === 1 ? 'A table has' : `${clean.mergedTables} tables have`} merged cells, kept as HTML`)
  const markdown = tidy(turndown().turndown(clean.html))
  return { markdown, media: clean.media, title, created, notes }
}

/** Blank lines collapsed, trailing spaces gone, one newline at the end. */
export function tidy(md: string) {
  // "-   item" (Turndown, Pandoc) → "- item", outside code blocks.
  let fenced = false
  const lines = md.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    return fenced ? line : line.replace(/^(\s*)([-*+]|\d+[.)])[ \t\u00a0]+(?=\S)/, '$1$2 ')
  })
  return (
    lines
      .join('\n')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .trimEnd() + '\n'
  )
}

/** "2021-03-04T10:00:00Z" → "2021-03-04"; anything unreadable → undefined. */
export function dateOf(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10)
}
