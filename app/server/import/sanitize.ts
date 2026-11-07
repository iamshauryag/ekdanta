// Making imported HTML safe before it becomes Markdown: no scripts, no styles, no frames or plugins,
// no event handlers, no javascript:/vbscript: links. Images carried inline as data: URLs are taken
// out and kept as files, so a note links to an attachment instead of holding megabytes of base64.
import { parseHTML } from 'linkedom'

/** A file pulled out of the document (an inline image), to be saved beside the note. */
export interface Media {
  name: string
  data: Buffer
}

/** Links to media are written with this prefix until the note's attachment folder is known. */
export const MEDIA_PREFIX = 'ekdanta-media:'

const DROP = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'noscript',
  'template',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'svg',
  'math',
]
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'srcset']
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp' }

/** A URL that would run code when followed. Browsers ignore whitespace and control characters inside the scheme. */
export function isScriptUrl(url: string) {
  // eslint-disable-next-line no-control-regex
  const u = url.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase()
  if (/^(javascript|vbscript|livescript):/.test(u)) return true
  // data: is fine for a picture, never for a page or a script (SVG can carry one).
  return u.startsWith('data:') && !/^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/.test(u)
}

export interface Sanitized {
  html: string
  media: Media[]
  /** True when a table with merged cells was found (it stays HTML in the Markdown). */
  mergedTables: number
  /** What was taken out, for the review sheet. */
  removed: { scripts: number; links: number }
}

/**
 * Clean an HTML fragment or document. `prefix` names extracted images (`<prefix>-1.png`), so
 * images from different documents never collide.
 */
export function sanitizeHtml(html: string, prefix = 'image'): Sanitized {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${bodyOf(html)}</body></html>`)
  const media: Media[] = []
  const removed = { scripts: 0, links: 0 }
  for (const tag of DROP) {
    for (const el of [...document.querySelectorAll(tag)]) {
      if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed') removed.scripts++
      el.remove()
    }
  }
  // Comments can hide conditional markup (<!--[if IE]><script>…); they're never content.
  const walker = document.createTreeWalker(document.body, 128 /* NodeFilter.SHOW_COMMENT */)
  const comments: Node[] = []
  while (walker.nextNode()) comments.push(walker.currentNode)
  comments.forEach((c) => c.parentNode?.removeChild(c))

  for (const el of [...document.body.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'formaction') el.removeAttribute(attr.name)
      else if (URL_ATTRS.includes(name) && isScriptUrl(attr.value)) {
        el.removeAttribute(attr.name)
        if (el.tagName === 'A') removed.links++
      }
    }
    if (el.tagName === 'A' && !el.getAttribute('href')) {
      // A link that led nowhere safe keeps its text and loses the link.
      el.replaceWith(...el.childNodes)
    }
  }
  for (const img of [...document.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? ''
    const m = src.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/is)
    if (m) {
      const ext = IMAGE_EXT[m[1].toLowerCase()]
      if (!ext) {
        img.remove()
        continue
      }
      const name = `${prefix}-${media.length + 1}.${ext}`
      media.push({ name, data: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') })
      img.setAttribute('src', MEDIA_PREFIX + name)
    } else if (!src) img.remove()
  }
  let mergedTables = 0
  for (const table of [...document.querySelectorAll('table')]) {
    // Word puts each cell's text in paragraphs; a Markdown cell is one line, so they become line breaks.
    for (const cell of [...table.querySelectorAll('td, th')]) {
      const paras = [...cell.children].filter((c) => c.tagName === 'P')
      paras.forEach((p, i) => {
        if (i > 0) p.before(document.createElement('br'))
        p.replaceWith(...p.childNodes)
      })
    }
    const cells = [...table.querySelectorAll('td, th')]
    const merged = cells.some((c) => Number(c.getAttribute('colspan') ?? 1) > 1 || Number(c.getAttribute('rowspan') ?? 1) > 1)
    if (merged) {
      mergedTables++
      table.setAttribute('data-merged', 'true')
      // Kept as raw HTML, so only the structure survives: no classes, ids, widths or column groups.
      table.querySelectorAll('colgroup').forEach((c) => c.remove())
      for (const el of [table, ...table.querySelectorAll('*')]) {
        for (const attr of [...el.attributes]) if (!['colspan', 'rowspan', 'href', 'src', 'alt', 'data-merged'].includes(attr.name.toLowerCase())) el.removeAttribute(attr.name)
      }
    } else if (!table.querySelector('th')) promoteHeader(document, table)
  }
  return { html: document.body.innerHTML, media, mergedTables, removed }
}

/** A table without a heading row gets its first row as one, so it can be a Markdown table. */
function promoteHeader(document: Document, table: Element) {
  const first = table.querySelector('tr')
  if (!first) return
  for (const td of [...first.querySelectorAll('td')]) {
    const th = document.createElement('th')
    th.append(...td.childNodes)
    td.replaceWith(th)
  }
}

/** The inside of <body>, or the whole string if there isn't one. */
function bodyOf(html: string) {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  return m ? m[1] : html.replace(/<!doctype[^>]*>/i, '').replace(/<head[\s\S]*?<\/head>/i, '')
}
