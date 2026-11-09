// A PDF's text, put back in reading order as Markdown. A PDF only says where each run of text is drawn,
// so the structure is rebuilt from positions: runs on one baseline make a line, a gutter down the
// middle of a page makes two columns, lines that repeat at the top or bottom of most pages are running
// headers and footers, a larger size than the body text (or a bold line alone) is a heading, and the
// spacing and indents between lines say where a paragraph ends. Each run's font says whether it's bold
// or italic, and a link box over it gives its address. A tagged PDF also says what each run is
// (heading, list item, paragraph), and that's followed where it's there. Pure functions: no pdf.js, no file system, so it can be
// tested with made-up pages.

/** One run of text: x is its left edge and y its baseline, from the top of the page, in points. */
export interface PdfItem {
  str: string
  x: number
  y: number
  w: number
  size: number
  /** From the font's name. */
  bold?: boolean
  italic?: boolean
  /** The web or mail address a link on the page puts over this run. */
  link?: string
  /** Where a tagged PDF puts this run in its structure. */
  tag?: PdfTag
}

/** A run's place in a tagged PDF: the block holding it (one key per paragraph, heading or item), and what that block is. */
export interface PdfTag {
  block?: string
  /** 1 to 6. */
  heading?: number
  /** The list item, and how deep its list is nested (0 for a list of its own). */
  li?: string
  depth?: number
  /** Whether the item has its label (bullet or number) on this page: the part of an item carried over a page break has none. */
  lbl?: boolean
  quote?: boolean
}

/** A stretch of a line in one style. */
export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  link?: string
}

export interface PdfPage {
  width: number
  height: number
  items: PdfItem[]
}

export interface Layout {
  markdown: string
  /** Pages read as two columns. */
  twoColumns: number
  /** Tables rebuilt from text laid out in columns. */
  tables: number
  /** Characters that came out as no real letter (private-use glyphs, U+FFFD): the fonts lack a map to Unicode. */
  garbled: number
  /** All characters kept. */
  chars: number
  /** Running headers and footers left out (as first seen, with how many pages had them), and page numbers. */
  removed: Removed
  /** Words broken at a line end that were joined into one ("long-" + "winded" → "longwinded"). */
  rejoined: string[]
}

export interface Removed {
  running: { text: string; pages: number }[]
  pageNumbers: number
}

export interface Line {
  text: string
  x: number
  right: number
  y: number
  size: number
  page: number
  /** 0 for a line across the page, 1 and 2 for the left and right columns. */
  col: number
  /** The line split where its text has wide gaps, for spotting tables. */
  cells: { text: string; x: number }[]
  /** The line split wherever two runs have space between them, for spotting tightly set tables. */
  runs: { text: string; x: number }[]
  /** The text by style; joined, it's `text`. */
  spans: Span[]
  /** The first tagged run's place in the structure. */
  tag?: PdfTag
}

// Bullets as drawn, including the private-use code points Word's Symbol and Wingdings bullets come out as.
// Dashes other than '-' open dialogue far more often than lists, so they're text.
const BULLET = /^([•◦▪▫●○■□►▸▹‣⁃∙➢➤✓✔❖\uF0A7\uF0B7\uF076\uF0D8\uF0FC\uF0A8\uF06E\uF0E0]\s*|[-*·]\s+)(?=\S)/u
// Numbered items only; "a)" and "(a)" stay as written, since Markdown has no lettered lists.
const NUMBERED = /^(\d{1,3}[.)]|\(\d{1,3}\))\s+(?=\S)/
// Word's second-level bullet is a letter o. It's a word in some languages, so like a number it only
// starts an item where it doesn't carry on a sentence, and not before a lower-case word.
const LETTER_O = /^o\s+(?=[^\p{Ll}\s])/u
const ENDS_SENTENCE = /[.!?:;…"”’)\]]$/

/** The pages' text as Markdown. */
export function layoutPages(pages: PdfPage[]): Layout {
  let twoColumns = 0
  const lines: Line[] = []
  pages.forEach((page, n) => {
    const { lines: pageLines, gutter } = pageToLines(page, n)
    if (gutter !== null) twoColumns++
    lines.push(...pageLines)
  })
  const { lines: body, removed } = dropRunningLines(lines, pages)
  const words = wordSet(body)
  const rejoined: string[] = []
  const { markdown, tables } = toMarkdown(body, words, rejoined)
  const text = body.map((l) => l.text).join('')
  // Private-use glyphs at the start of a line are bullets, read as such below; anywhere else they're letters lost.
  const garbled = (text.match(/[\uE000-\uF8FF\uFFFD]/g) ?? []).length - body.filter((l) => /^[\uE000-\uF8FF]/.test(l.text)).length
  return { markdown, twoColumns, tables, garbled: Math.max(0, garbled), chars: text.replace(/\s/g, '').length, removed, rejoined }
}

// ---- Lines and columns ----------------------------------------------------------------------------

/** A page's lines in reading order: across-the-page lines in place, each two-column stretch left column first. */
export function pageToLines(page: PdfPage, n: number): { lines: Line[]; gutter: number | null } {
  const items = page.items.filter((it) => it.str.trim() && it.size > 0 && Number.isFinite(it.x + it.y + it.w))
  const rows = toRows(items)
  const gutter = findGutter(rows, page.width)
  const out: Line[] = []
  let left: Line[] = []
  let right: Line[] = []
  const flush = () => {
    out.push(...left, ...right)
    left = []
    right = []
  }
  for (const row of rows) {
    if (gutter === null || row.some((it) => spans(it, gutter))) {
      flush()
      out.push(toLine(row, n, 0))
      continue
    }
    const l = row.filter((it) => it.x < gutter)
    const r = row.filter((it) => it.x >= gutter)
    if (l.length) left.push(toLine(l, n, 1))
    if (r.length) right.push(toLine(r, n, 2))
  }
  flush()
  return { lines: out, gutter }
}

/** Runs grouped into rows by baseline, top to bottom; a raised footnote mark stays on its line. */
function toRows(items: PdfItem[]): PdfItem[][] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: { y: number; size: number; items: PdfItem[] }[] = []
  for (const it of sorted) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(it.y - row.y) <= 0.45 * Math.min(it.size, row.size)) row.items.push(it)
    else rows.push({ y: it.y, size: it.size, items: [it] })
  }
  return rows.map((r) => r.items.sort((a, b) => a.x - b.x))
}

const spans = (it: PdfItem, x: number) => it.x < x - 0.5 && it.x + it.w > x + 0.5

/**
 * Where a page splits into two columns, or null. A gutter is an upright strip near the middle that
 * most rows don't cross, with long runs of text on both sides of it in many rows. A table also has
 * empty strips, but its cells are short, so columns must be mostly filled to count.
 */
export function findGutter(rows: PdfItem[][], width: number): number | null {
  if (rows.length < 6 || !(width > 0)) return null
  const crossAt = (x: number) => rows.filter((r) => r.some((it) => spans(it, x))).length
  let best = -1
  let bestCross = Infinity
  for (let x = Math.round(width * 0.3); x <= width * 0.7; x++) {
    const cross = crossAt(x)
    if (cross < bestCross) {
      bestCross = cross
      best = x
    }
  }
  if (best < 0) return null
  // The middle of the empty strip, not its edge.
  let lo = best
  let hi = best
  while (lo > width * 0.25 && crossAt(lo - 1) === bestCross) lo--
  while (hi < width * 0.75 && crossAt(hi + 1) === bestCross) hi++
  const g = (lo + hi) / 2
  const split = rows.filter((r) => !r.some((it) => spans(it, g)))
  if (bestCross > split.length) return null
  const lefts = split.map((r) => r.filter((it) => it.x + it.w <= g)).filter((r) => r.length)
  const rights = split.map((r) => r.filter((it) => it.x >= g)).filter((r) => r.length)
  const both = split.filter((r) => r.some((it) => it.x + it.w <= g) && r.some((it) => it.x >= g)).length
  if (lefts.length < 5 || rights.length < 5 || both < 3) return null
  const extent = (r: PdfItem[]) => r[r.length - 1].x + r[r.length - 1].w - r[0].x
  const minX = Math.min(...lefts.map((r) => r[0].x))
  const maxX = Math.max(...rights.map((r) => r[r.length - 1].x + r[r.length - 1].w))
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
  if (mean(lefts.map(extent)) < 0.6 * (g - minX) || mean(rights.map(extent)) < 0.6 * (maxX - g)) return null
  return g
}

/** A row's runs as one line of text. */
function toLine(row: PdfItem[], page: number, col: number): Line {
  // Fake bold: the same run drawn twice, a hair apart. It's drawn once, and bold.
  const items: PdfItem[] = []
  for (const it of row) {
    const prev = items[items.length - 1]
    if (prev && it.str === prev.str && Math.abs(it.x - prev.x) < 0.3 * it.size) items[items.length - 1] = { ...prev, bold: true }
    else items.push(it)
  }
  const cells: { text: string; x: number }[] = []
  const runs: { text: string; x: number }[] = []
  const spans: Span[] = []
  const add = (text: string, style: Omit<Span, 'text'>) => {
    const last = spans[spans.length - 1]
    if (last && sameStyle(last, style)) last.text += text
    else spans.push({ text, ...style })
  }
  let prev: PdfItem | null = null
  const bySize = new Map<number, number>()
  for (const it of items) {
    const gap = prev ? it.x - (prev.x + prev.w) : 0
    const space = !!prev && gap > 0.15 * it.size && !/\s$/.test(prev.str) && !/^\s/.test(it.str)
    if (!prev || gap > 2 * Math.max(it.size, prev.size)) cells.push({ text: it.str, x: it.x })
    else cells[cells.length - 1].text += (space ? ' ' : '') + it.str
    if (!prev || space) runs.push({ text: it.str, x: it.x })
    else runs[runs.length - 1].text += it.str
    // A space between two runs takes only the style they share, so "**a** b" stays apart.
    if (space) add(' ', shared(prev!, it))
    add(it.str, styleOf(it))
    const size = Math.round(it.size * 2) / 2
    bySize.set(size, (bySize.get(size) ?? 0) + it.str.length)
    prev = it
  }
  const last = items[items.length - 1]
  const tidy = tidySpans(spans)
  return {
    text: tidy.map((s) => s.text).join(''),
    x: items[0].x,
    right: last.x + last.w,
    y: Math.min(...items.map((it) => it.y)),
    size: [...bySize].sort((a, b) => b[1] - a[1])[0][0],
    page,
    col,
    cells: tidyCells(cells),
    runs: tidyCells(runs),
    spans: tidy,
    tag: items.find((it) => it.tag)?.tag,
  }
}

const styleOf = (it: PdfItem | Span): Omit<Span, 'text'> => ({
  ...(it.bold ? { bold: true } : {}),
  ...(it.italic ? { italic: true } : {}),
  ...(it.link ? { link: it.link } : {}),
})
const shared = (a: PdfItem | Span, b: PdfItem | Span): Omit<Span, 'text'> => ({
  ...(a.bold && b.bold ? { bold: true } : {}),
  ...(a.italic && b.italic ? { italic: true } : {}),
  ...(a.link && a.link === b.link ? { link: a.link } : {}),
})
const sameStyle = (a: Omit<Span, 'text'>, b: Omit<Span, 'text'>) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && a.link === b.link

/** Spans with runs of white space made one space, none at the ends, and none empty. */
function tidySpans(spans: Span[]): Span[] {
  const out: Span[] = []
  let space = true
  for (const s of spans) {
    let text = ''
    for (const ch of s.text.replace(/\s+/g, ' ')) {
      if (ch === ' ' && space) continue
      text += ch
      space = ch === ' '
    }
    if (text) out.push({ ...s, text })
  }
  while (out.length && out[out.length - 1].text.endsWith(' ')) {
    const last = out[out.length - 1]
    last.text = last.text.trimEnd()
    if (!last.text) out.pop()
  }
  return out
}

/** Bold and italic from a font's name: "ABCDEF+Georgia-BoldItalic", "Arial,Bold", "MinionPro-SemiboldIt". */
export function fontStyle(name: string): { bold?: true; italic?: true } {
  const n = name.replace(/^[A-Z]{6}\+/, '')
  return {
    ...(/bold|black(?!letter)|heavy|demi(?!-?light)|semibd|[-,_ ](?:bd|sb|hv|blk)(?:it)?$/i.test(n) ? { bold: true as const } : {}),
    // "-It" only after a weight ("MinionPro-SemiboldIt"), not any name that happens to end so.
    ...(/italic|oblique|inclined|slanted|kursiv|[-,_ ](?:it|bdit|sbit)$/i.test(n) ||
    /-(?:Bold|Semibold|SemiBold|Light|Medium|Regular|Book|Black|Heavy|ExtraBold|Extrabold|Thin|Demi|Cond|Bd|Lt|Md|Sb|Smbd)?It$/.test(n)
      ? { italic: true as const }
      : {}),
  }
}

/** A link address that's safe to keep: web or mail only, with what would end a Markdown link encoded. */
export function safeUrl(raw: string): string | null {
  const url = raw.trim()
  if (!/^(https?:\/\/[^\s/]|mailto:[^\s])/i.test(url) || url.length > 2000 || /[\u0000-\u001f\u007f]/.test(url)) return null
  return url.replace(/[ ()<>\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
}

const tidyCells = (cells: { text: string; x: number }[]) => cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text)

// ---- Running headers, footers and page numbers -------------------------------------------------------

/**
 * Lines without the running headers and footers, and what was taken out. A running line sits in the
 * top or bottom tenth of the page and repeats (numbers aside) on at least three pages and a good
 * share of them; a short document keeps everything that doesn't. A page number is a number on its
 * own in the margin that counts up with the pages ("12", "Page 12", "12 of 40", "- 12 -", "xii").
 */
export function dropRunningLines(lines: Line[], pages: PdfPage[]): { lines: Line[]; removed: Removed } {
  const key = (l: Line) => l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
  // A heading that opens each page ("Section 3") isn't a running header: those are set no larger than the text.
  const weight = new Map<number, number>()
  for (const l of lines) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length)
  const bodySize = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  const heading = (l: Line) => l.size >= bodySize * 1.15 || !!l.tag?.heading
  // Lines on one baseline are one row here, so a header split by a page's columns is still one header.
  const rows = new Map<Line, Line[]>()
  const byPage = new Map<number, Line[]>()
  for (const l of lines) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l])
  for (const [p, list] of byPage) {
    const h = pages[p].height
    const on = [...list].sort((a, b) => a.y - b.y || a.x - b.x)
    const pageRows: Line[][] = []
    for (const l of on) {
      const row = pageRows[pageRows.length - 1]
      if (row && Math.abs(l.y - row[0].y) < 0.3 * l.size) row.push(l)
      else pageRows.push([l])
    }
    // The first and last two rows of a page, if they sit in its margins.
    for (const row of new Set([...pageRows.slice(0, 2), ...pageRows.slice(-2)])) {
      if (!(row[0].y < h * 0.1 || row[0].y > h * 0.9) || row.some(heading)) continue
      const text = row.map((l) => l.text).join(' ')
      rows.set(row.length === 1 ? row[0] : { ...row[0], text }, row)
    }
  }
  const edge = [...rows.keys()]
  const numbers = pageNumbers(edge)
  const pagesWith = new Map<string, Set<number>>()
  for (const l of edge) if (!numbers.has(l)) pagesWith.set(key(l), (pagesWith.get(key(l)) ?? new Set()).add(l.page))
  // Odd and even pages often carry different headers, so a little under half the pages is enough.
  const enough = Math.max(3, Math.ceil(pages.length * 0.4))
  const running = new Set([...pagesWith].filter(([, on]) => on.size >= enough).map(([k]) => k))
  const removed: Removed = { running: [], pageNumbers: numbers.size }
  for (const k of running) removed.running.push({ text: edge.find((l) => key(l) === k)!.text, pages: pagesWith.get(k)!.size })
  const drop = new Set(edge.filter((l) => numbers.has(l) || running.has(key(l))).flatMap((l) => rows.get(l)!))
  return { lines: lines.filter((l) => !drop.has(l)), removed }
}

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10 }
/** "iv" → 4, for the small numerals front matter is numbered in. */
function roman(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]]
    n += v < (ROMAN[s[i + 1]] ?? 0) ? -v : v
  }
  return n
}

/**
 * Margin lines that are page numbers. Each candidate's number, less its page's place, is its offset;
 * candidates sharing an offset with another (or numbered exactly as their page) count, so a lone "4/4"
 * or "iv" on a one-page note stays as text. "n of m" and "n/m" also need the same m throughout.
 */
function pageNumbers(edge: Line[]): Set<Line> {
  const found: { line: Line; offset: number; group: string }[] = []
  for (const l of edge) {
    const t = l.text.trim().toLowerCase()
    let m: RegExpMatchArray | null
    if ((m = t.match(/^(?:page\s+)?(\d{1,4})(?:\s*(?:of|\/)\s*(\d{1,4}))?$/)) || (m = t.match(/^[-–—]\s*(\d{1,4})\s*[-–—]$/))) {
      const n = Number(m[1])
      if (m[2] && Number(m[2]) < n) continue
      found.push({ line: l, offset: n - (l.page + 1), group: m[2] ? `of ${m[2]}` : 'arabic' })
    } else if (/^[ivx]{1,4}$/.test(t)) found.push({ line: l, offset: roman(t) - (l.page + 1), group: 'roman' })
  }
  const counts = new Map<string, number>()
  for (const f of found) counts.set(`${f.group}:${f.offset}`, (counts.get(`${f.group}:${f.offset}`) ?? 0) + 1)
  return new Set(found.filter((f) => (counts.get(`${f.group}:${f.offset}`) ?? 0) >= 2 || (f.offset === 0 && f.group !== 'roman')).map((f) => f.line))
}

// ---- Blocks ---------------------------------------------------------------------------------------

/** Every word written whole somewhere, so a word split at a line end is joined the way the text spells it. */
function wordSet(lines: Line[]) {
  const words = new Set<string>()
  for (const l of lines) for (const w of l.text.toLowerCase().match(/\p{L}[\p{L}-]*\p{L}/gu) ?? []) words.add(w)
  return words
}

const mode = (values: number[]) => {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
}
const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : undefined
}

type Block =
  | { kind: 'p'; spans: Span[]; quote?: boolean; xs: number[]; rights: number[]; size: number; col: string }
  | { kind: 'h'; level: number; spans: Span[] }
  | { kind: 'li'; ordered: string | null; spans: Span[]; x: number; textX: number; depth: number; key?: string }
  | { kind: 'table'; rows: string[][] }

function toMarkdown(lines: Line[], words: Set<string>, rejoined: string[]): { markdown: string; tables: number } {
  if (!lines.length) return { markdown: '', tables: 0 }
  // The body size: the size most of the text is set in.
  const weight = new Map<number, number>()
  for (const l of lines) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length)
  const bodySize = [...weight].sort((a, b) => b[1] - a[1])[0][0]

  // A document set all in bold (or italic) has nothing to stand out from: that style is its plain text.
  const share = (style: 'bold' | 'italic') => {
    const body = lines.filter((l) => Math.abs(l.size - bodySize) < 0.6).flatMap((l) => l.spans)
    const all = body.reduce((n, sp) => n + sp.text.length, 0)
    return all ? body.reduce((n, sp) => n + (sp[style] ? sp.text.length : 0), 0) / all : 0
  }
  for (const style of ['bold', 'italic'] as const) if (share(style) > 0.6) for (const l of lines) for (const sp of l.spans) delete sp[style]
  const allBold = (l: Line) => l.spans.some((sp) => sp.bold) && l.spans.every((sp) => sp.bold || !/\p{L}/u.test(sp.text))

  // Each column's left and right edges, and how far apart lines of body text sit.
  const colKey = (l: Line) => `${l.page}:${l.col}`
  const groups = new Map<string, Line[]>()
  for (const l of lines) groups.set(colKey(l), [...(groups.get(colKey(l)) ?? []), l])
  const lefts = new Map<string, number>()
  const rights = new Map<string, number>()
  for (const [k, ls] of groups) {
    const body = ls.filter((l) => Math.abs(l.size - bodySize) < 0.6)
    const use = body.length ? body : ls
    lefts.set(k, mode(use.map((l) => Math.round(l.x))) ?? 0)
    const r = use.map((l) => l.right).sort((a, b) => a - b)
    rights.set(k, r[Math.floor(r.length * 0.9)] ?? 0)
  }
  const gaps: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const [a, b] = [lines[i - 1], lines[i]]
    if (colKey(a) === colKey(b) && a.size === bodySize && b.size === bodySize && b.y - a.y > 0.8 * bodySize && b.y - a.y < 3 * bodySize) gaps.push(b.y - a.y)
  }
  const pitch = median(gaps) ?? bodySize * 1.2
  // Whether paragraphs are set apart by space. If so, a line that merely stops short isn't the end of one.
  const opened = gaps.filter((g) => g > pitch * 1.45).length
  const spaced = opened >= 3 && opened >= 0.08 * gaps.length

  // A tagged PDF says which lines make one paragraph. Some tag every line as a paragraph of its own;
  // then its blocks aren't trusted, and the layout decides.
  const trust = blocksTrusted(lines)
  const blockOf = (l: Line) => (trust ? l.tag?.block : undefined)

  // Headings: tagged as one, or clearly larger than the body (a little larger will do in bold), and
  // short. Sizes rank them: the largest is level 1 only if it's used once (a title), otherwise
  // headings start at level 2.
  const short = (l: Line) => l.text.length <= 150 && l.text.split(' ').length <= 15 && /\p{L}{2}/u.test(l.text) && !/[,;]$/.test(l.text)
  const bySize = (l: Line) => (l.size >= bodySize * 1.15 || (l.size >= bodySize * 1.08 && allBold(l))) && short(l)
  const tagged = (l: Line) => (l.tag?.heading && l.text.length <= 200 && /\p{L}{2}/u.test(l.text) ? l.tag.heading : 0)
  const isHeading = (l: Line) => tagged(l) > 0 || bySize(l)
  const headingSizes = [...new Set(lines.filter(bySize).map((l) => Math.round(l.size)))].sort((a, b) => b - a)
  const titleOnce = headingSizes.length > 0 && lines.filter((l) => bySize(l) && Math.round(l.size) === headingSizes[0]).length === 1
  const levelOf = (l: Line) => Math.min(3, tagged(l) || headingSizes.indexOf(Math.round(l.size)) + (titleOnce ? 1 : 2))
  // A line in bold at the body size, standing alone, is the smallest heading, if the PDF doesn't say otherwise.
  const boldLevel = Math.min(3, headingSizes.length + (titleOnce ? 1 : 2))
  const boldHeading = (l: Line, next: Line | undefined) =>
    !l.tag?.heading &&
    !l.tag?.li &&
    !(blockOf(l) && next && blockOf(next) === blockOf(l)) &&
    allBold(l) &&
    Math.abs(l.size - bodySize) < 0.6 &&
    l.text.split(' ').length <= 8 &&
    l.text.length <= 70 &&
    /\p{L}{2}/u.test(l.text) &&
    !ENDS_SENTENCE.test(l.text) &&
    !/[,…]$/.test(l.text) &&
    !BULLET.test(l.text) &&
    !NUMBERED.test(l.text) &&
    !!next &&
    !allBold(next) &&
    !/^\p{Ll}/u.test(next.text)

  const tableish = (l: Line) => l.cells.length >= 3
  const blocks: Block[] = []
  const seenItems = new Set<string>()
  const usesLabels = lines.some((l) => l.tag?.li && l.tag.lbl)
  let listXs: number[] = []
  let tables = 0
  let prev: Line | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const b = blocks[blocks.length - 1]
    // Rows whose runs start at the same three or more places, one under another, are a table too.
    const aligned = alignedTable(lines, i)
    if (aligned) {
      blocks.push({ kind: 'table', rows: aligned.rows })
      tables++
      prev = null
      i = aligned.end
      continue
    }
    // A run of lines with three or more spaced-out cells is a table.
    if (tableish(l) && !l.tag?.li) {
      let j = i
      while (j + 1 < lines.length && tableish(lines[j + 1]) && lines[j + 1].page === l.page) j++
      if (j > i) {
        blocks.push({ kind: 'table', rows: lines.slice(i, j + 1).map((r) => r.cells.map((c) => c.text)) })
        tables++
        prev = null
        i = j
        continue
      }
    }
    // Lines the tags put in one block, on one page, are one block; lines they put apart are apart.
    const sameBlock = prev && blockOf(prev) && blockOf(l) && prev.page === l.page ? blockOf(prev) === blockOf(l) : null
    if (isHeading(l) && !(l.tag?.li && !l.tag.heading)) {
      // A heading that wraps onto a second line is one heading.
      const wraps =
        b?.kind === 'h' && prev && isHeading(prev) && (sameBlock ?? (prev.size === l.size && prev.page === l.page && l.y > prev.y && l.y - prev.y < l.size * 1.6 && levelOf(prev) === levelOf(l)))
      if (wraps) b.spans = joinSpans(b.spans, l.spans, words, [])
      else blocks.push({ kind: 'h', level: levelOf(l), spans: l.spans })
      listXs = []
      prev = l
      continue
    }
    const open = b && (b.kind === 'p' || b.kind === 'li') && prev && !isHeading(prev) ? b : null
    const item = l.tag?.li
    let newItem = !!item && !seenItems.has(item)
    const bullet = l.text.match(BULLET)
    const numbered = l.text.match(NUMBERED)
    // The tags number an item afresh on each page, so the part of an item carried over a page break
    // looks new: it has no label there (or, where the PDF tags no labels, it plainly carries on).
    if (newItem && open?.kind === 'li' && open.key && l.page !== prev!.page && !bullet && !numbered) {
      const carried = usesLabels ? !l.tag?.lbl : !ENDS_SENTENCE.test(prev!.text) && /^\p{Ll}/u.test(l.text)
      if (carried) {
        seenItems.add(item!)
        open.key = item
        newItem = false
      }
    }
    let continues: boolean
    if (open && item && open.kind === 'li' && open.key) continues = item === open.key
    else if (open && sameBlock !== null) continues = sameBlock && !newItem
    else continues = !!open && !newItem && continuesFrom(prev!, l, open, { left: lefts.get(colKey(l)) ?? l.x, right: rights.get(colKey(prev!)) ?? prev!.right, pitch, spaced })
    const midSentence = continues && !ENDS_SENTENCE.test(prev!.text)
    // In an open item, an "o" line under the item's text is the text wrapping; one set in further is a
    // sub-item, and one under the item's own bullet is the next item.
    const besideItem = open?.kind === 'li' && (l.x > open.textX + 0.5 * l.size || l.x <= open.x + 0.5 * l.size)
    const o = !bullet && (!midSentence || besideItem) ? l.text.match(LETTER_O) : null
    // A numbered line in the middle of a sentence is the sentence going on ("… see chapter\n3. Then …"),
    // unless it lines up under the list item before it.
    const underItem = open?.kind === 'li' && l.x <= open.x + 0.5 * l.size
    const listStart = newItem || (!item && (bullet || o || (numbered && (underItem || !midSentence))))
    if (listStart) {
      if (item) seenItems.add(item)
      // A tagged item's bullet may be drawn rather than written; then it has no marker in its text.
      const m = bullet ?? o ?? numbered
      let depth: number
      if (item) depth = l.tag?.depth ?? 0
      else {
        if (b?.kind !== 'li' || !open) listXs = []
        while (listXs.length && l.x < listXs[listXs.length - 1] - 0.5 * l.size) listXs.pop()
        if (!listXs.length || l.x > listXs[listXs.length - 1] + 0.5 * l.size) listXs.push(l.x)
        depth = listXs.length - 1
      }
      // Where the item's text starts: the run after a bullet drawn apart, or a share of the line's width.
      const textX = !m ? l.x : l.runs.length > 1 && l.runs[0].text === m[0].trim() ? l.runs[1].x : l.x + ((l.right - l.x) * m[0].length) / Math.max(l.text.length, 1)
      blocks.push({ kind: 'li', ordered: m && m === numbered ? m[1].replace(/[().]/g, '') : null, spans: dropStart(l.spans, m ? m[0].length : 0), x: l.x, textX, depth, key: item })
    } else if (continues) open!.spans = joinSpans(open!.spans, l.spans, words, rejoined)
    else {
      blocks.push({ kind: 'p', spans: l.spans, quote: !!l.tag?.quote, xs: [], rights: [], size: l.size, col: colKey(l) })
      listXs = []
    }
    const now = blocks[blocks.length - 1]
    if (now.kind === 'p') {
      now.xs.push(l.x)
      now.rights.push(l.right)
    }
    // Bold at the body size, alone on its line, with plain text after it: a heading the PDF doesn't mark as one.
    if (now.kind === 'p' && now.xs.length === 1 && boldHeading(l, lines[i + 1])) blocks[blocks.length - 1] = { kind: 'h', level: boldLevel, spans: l.spans }
    prev = l
  }
  // A quotation: prose set in from both margins, its lines flush with each other and, but for the
  // last, each filling the narrower measure. Not a sign-off, address or caption set far across the page,
  // and two lines need a deeper indent than a paragraph's.
  blocks.forEach((b, n) => {
    if (b.kind !== 'p' || b.quote || b.xs.length < 2 || blocks[n - 1]?.kind === 'li') return
    const [left, right] = [lefts.get(b.col) ?? 0, rights.get(b.col) ?? 0]
    const indent = b.xs[0] - left
    const measure = Math.max(...b.rights)
    const prose = b.rights.slice(0, -1).every((r) => r >= measure - 3 * b.size) && measure >= right - indent - 3 * b.size
    if (b.xs.every((x) => Math.abs(x - b.xs[0]) < 1) && indent >= (b.xs.length > 2 ? 1.5 : 2) * b.size && indent <= 0.2 * (right - left) && measure <= right - 1.5 * b.size && prose) b.quote = true
  })
  return { markdown: render(blocks), tables }
}

/**
 * Whether a tagged PDF's blocks can be trusted to say where paragraphs end. Where the text plainly
 * carries on from one line to the next (no full stop, lower case after), the two lines should share
 * a block; in a PDF tagged line by line they don't.
 */
function blocksTrusted(lines: Line[]): boolean {
  let carry = 0
  let same = 0
  for (let i = 1; i < lines.length; i++) {
    const [a, b] = [lines[i - 1], lines[i]]
    if (!a.tag?.block || !b.tag?.block || a.page !== b.page || a.col !== b.col) continue
    if (ENDS_SENTENCE.test(a.text) || !/^\p{Ll}/u.test(b.text)) continue
    carry++
    if (a.tag.block === b.tag.block) same++
  }
  return carry < 3 || same >= 0.7 * carry
}

/** Spans without their first n characters (a bullet or number written into the text). */
function dropStart(spans: Span[], n: number): Span[] {
  const out: Span[] = []
  for (const sp of spans) {
    if (n >= sp.text.length) {
      n -= sp.text.length
      continue
    }
    out.push({ ...sp, text: sp.text.slice(n) })
    n = 0
  }
  if (out.length) out[0] = { ...out[0], text: out[0].text.trimStart() }
  return out.filter((sp) => sp.text)
}

/** Two lines of a paragraph as one, mended as join() mends plain text, keeping each part's style. */
function joinSpans(a: Span[], b: Span[], words: Set<string>, rejoined: string[]): Span[] {
  if (!a.length) return b
  if (!b.length) return a
  const at = a.map((sp) => sp.text).join('')
  const bt = b.map((sp) => sp.text).join('')
  const joined = join(at, bt, words, rejoined)
  const out = a.map((sp) => ({ ...sp }))
  const last = out[out.length - 1]
  const first = b[0]
  if (joined === at + ' ' + bt) out.push({ text: ' ', ...shared(last, first) })
  else if (joined === at.slice(0, -1) + bt) last.text = last.text.slice(0, -1)
  else if (joined === at.slice(0, -1) + '-' + bt) last.text = last.text.slice(0, -1) + '-'
  return tidySpans([...out, ...b.map((sp) => ({ ...sp }))])
}

/**
 * A table set so tightly that its cells are a word space apart: at least three rows, the first with
 * three or more runs, each later row's runs starting under the first row's. Prose never lines up so.
 */
function alignedTable(lines: Line[], i: number): { end: number; rows: string[][] } | null {
  const head = lines[i]
  if (head.runs.length < 3) return null
  const cols = head.runs.map((r) => r.x)
  const tol = Math.max(1.5, head.size * 0.15)
  const rows = [head.runs.map((r) => r.text)]
  let j = i
  while (j + 1 < lines.length) {
    const next = lines[j + 1]
    if (next.page !== head.page || next.col !== head.col || next.runs.length < 2 || next.y - lines[j].y > 3 * next.size || next.y <= lines[j].y) break
    const at = next.runs.map((r) => cols.findIndex((x) => Math.abs(x - r.x) <= tol))
    if (at.some((n) => n < 0) || at[0] !== 0 || new Set(at).size !== at.length) break
    const row = cols.map(() => '')
    next.runs.forEach((r, n) => (row[at[n]] = r.text))
    rows.push(row)
    j++
  }
  return rows.length >= 3 ? { end: j, rows } : null
}

/** Whether a line carries on the paragraph or list item before it. */
function continuesFrom(prev: Line, l: Line, block: Block, col: { left: number; right: number; pitch: number; spaced?: boolean }): boolean {
  const carriesOn = (/\p{L}[-\u2010\u00ad]$/u.test(prev.text) || !ENDS_SENTENCE.test(prev.text)) && /^[\p{Ll}\d(]/u.test(l.text)
  // Across a page or column break, only text that plainly carries on (no full stop, lower case next) continues.
  if (l.page !== prev.page || l.col !== prev.col || l.y < prev.y) return carriesOn
  if (Math.abs(l.size - prev.size) > 0.1 * prev.size) return false
  const gap = l.y - prev.y
  if (gap > col.pitch * 1.45 && gap > l.size * 1.5) return false
  // An item's second line hangs under its text, not under its bullet.
  if (block.kind === 'li') return l.x > block.x + 0.5 * l.size || carriesOn
  // A first-line indent starts a paragraph.
  if (l.x - col.left > 0.8 * l.size && prev.x - col.left < 0.5 * l.size) return false
  // A short line that ends a sentence ends the paragraph, unless paragraphs are set apart by space:
  // then the space says where they end, and a line that stops short in a narrow column is just short.
  // (Set-in lines are still split there: list items whose bullets are drawn have no space between them.)
  const setIn = prev.x - col.left >= 1.5 * l.size && Math.abs(l.x - prev.x) < 1
  if ((!col.spaced || setIn) && ENDS_SENTENCE.test(prev.text) && prev.right < col.right - Math.max(4 * l.size, (col.right - col.left) * 0.15)) return false
  // So does a line well short of the margin with a capital after it: list items whose bullets are drawn, not written.
  if (prev.right < col.right - (col.right - col.left) * 0.35 && /^\p{Lu}/u.test(l.text)) return false
  return true
}

// Short words that follow a hyphen left hanging on purpose: "pre- and post-war".
const HANGING = new Set(['and', 'or', 'nor', 'to', 'but', 'as', 'than', 'und', 'oder', 'et', 'ou', 'y', 'o'])

/**
 * Two lines of a paragraph as one. A word broken at the line end is mended: kept hyphenated when it
 * already has a hyphen inside ("state-of-the-" + "art") or the text spells it so elsewhere, the hyphen
 * left hanging before "and"/"or", and otherwise joined, with the joined word recorded for the writer.
 */
export function join(a: string, b: string, words: Set<string> = new Set(), rejoined: string[] = []): string {
  if (a.endsWith('\u00ad')) return a.slice(0, -1) + b
  const m = a.match(/([\p{L}-]*?)(\p{L}+)[-\u2010]$/u)
  if (m && /^\p{Ll}/u.test(b)) {
    const rest = b.match(/^\p{L}+/u)![0]
    if (HANGING.has(rest.toLowerCase()) && b.length > rest.length) return a + ' ' + b
    const hyphenated = `${m[2]}-${rest}`.toLowerCase()
    if (m[1].endsWith('-') || (words.has(hyphenated) && !words.has(hyphenated.replace('-', '')))) return a.slice(0, -1) + '-' + b
    // Only a word the text doesn't spell whole anywhere else is worth the writer's check.
    if (!words.has((m[2] + rest).toLowerCase())) rejoined.push(m[2] + rest)
    return a.slice(0, -1) + b
  }
  if (/[—/]$/.test(a)) return a + b
  return a + ' ' + b
}

// ---- Markdown ------------------------------------------------------------------------------------

/**
 * Text that Markdown, or Obsidian, would read as markup, escaped: emphasis, code, links and HTML, a
 * #tag at a word's start, ==highlight==, ~~strikethrough~~, %%comments%%, $maths$ (where a second '$' could
 * close it), and &entities;.
 */
export function escapeMd(s: string): string {
  return escapeMaths(
    s
      .replace(/([\\`*_[\]])/g, '\\$1')
      .replace(/<(?=[A-Za-z/!?])/g, '\\<')
      .replace(/(^|\s)#(?=[^\s#])/g, '$1\\#')
      .replace(/([=~%])\1+/g, (run) => run.replace(/./g, '\\$&'))
      .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&'),
  )
}

/** '$' escaped only where it could open or close maths: when another (unescaped) '$' is on the line. */
function escapeMaths(s: string): string {
  return s
    .split('\n')
    .map((line) => ((line.match(/(?<!\\)\$/g) ?? []).length > 1 ? line.replace(/(?<!\\)\$/g, '\\$') : line))
    .join('\n')
}

/** A paragraph that would start a heading, quote, list or rule, escaped at its start. */
// A rule or fence of its own ("---", "~~~", "==="), or one opening a paragraph, would be read as markup
// (or, first in a note, as front matter). '*' and '_' are already escaped everywhere.
const escapeStart = (s: string) => s.replace(/^(#{1,6}(\s|$)|>|[-+](\s|$)|-{2,}|~{3,}|=+)/, '\\$1').replace(/^(\d+)([.)])(\s|$)/, '$1\\$2$3')

function render(blocks: Block[]): string {
  let out = ''
  // Where each depth of list item's text starts, so a nested item lines up under its parent's text.
  const pads: number[] = []
  let depth = -1
  blocks.forEach((b, i) => {
    let text: string
    if (b.kind === 'h') {
      // A heading's own weight isn't emphasis; italic is, unless the whole heading is set in it.
      const italic = b.spans.every((sp) => sp.italic || !sp.text.trim())
      text = `${'#'.repeat(b.level)} ${inline(b.spans.map((sp) => ({ ...sp, bold: false, italic: sp.italic && !italic })))}`
    } else if (b.kind === 'li') {
      // An item can be nested one deeper than the item before it, at most.
      depth = blocks[i - 1]?.kind === 'li' ? Math.min(b.depth, depth + 1) : 0
      const marker = b.ordered && /^\d+$/.test(b.ordered) ? `${b.ordered}. ` : '- '
      const indent = depth ? pads[depth - 1] : 0
      pads[depth] = indent + marker.length
      text = ' '.repeat(indent) + marker + escapeStart(inline(b.spans))
    } else if (b.kind === 'table') {
      const width = Math.max(...b.rows.map((r) => r.length))
      const row = (r: string[]) => '| ' + Array.from({ length: width }, (_, n) => escapeMd(r[n] ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |'
      text = [row(b.rows[0]), '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |', ...b.rows.slice(1).map(row)].join('\n')
    } else text = (b.quote ? '> ' : '') + escapeStart(inline(b.spans))
    // List items sit on consecutive lines; everything else is separated by a blank line.
    if (i) out += b.kind === 'li' && blocks[i - 1].kind === 'li' ? '\n' : '\n\n'
    out += text
  })
  return out ? out + '\n' : ''
}

/**
 * Spans as Markdown: links around their text, bold around italic. Markers go inside the spaces and
 * punctuation around a styled stretch, so each one sits against a letter, and every marker is checked
 * against what's beside it by CommonMark's rules: an italic that can't open or close with '*' tries
 * '_', and emphasis that can't be written validly either way is left plain rather than shown as stars.
 */
export function inline(spans: Span[]): string {
  const parts = groups(spans, (sp) => sp.link ?? '')
  let out = ''
  parts.forEach((g, n) => {
    const after = parts[n + 1] ? (parts[n + 1].key ? '[' : '') : ''
    if (!g.key) return (out += emphasis(g.spans, out.slice(-1), after))
    const [lead, core, trail] = outerSpace(g.spans.map((sp) => sp.text).join(''))
    if (!core) return (out += emphasis(g.spans, out.slice(-1), after))
    out += `${escapeMd(lead)}[${emphasis(trimSpans(g.spans), '[', ']')}](${g.key})${escapeMd(trail)}`
  })
  // A '$' in one styled stretch can pair with one in another, so the whole line is checked again.
  return escapeMaths(out)
}

type Tok = { text: string } | { pair: number; open: boolean; kind: 'b' | 'i' }

/** Spans without links as Markdown, between the characters `before` and `after` ('' for a line's ends). */
function emphasis(list: Span[], before: string, after: string): string {
  const toks: Tok[] = []
  let pairs = 0
  // Spaces and punctuation at a stretch's ends go outside its markers.
  const ends = (t: string) => t.match(/^([\s\p{P}\p{S}]*)([\s\S]*?)([\s\p{P}\p{S}]*)$/u)!.slice(1, 4) as [string, string, string]
  const text = (t: string) => t && toks.push({ text: escapeMd(t) })
  const mark = (kind: 'b' | 'i', body: () => void) => {
    const pair = pairs++
    toks.push({ pair, open: true, kind })
    body()
    toks.push({ pair, open: false, kind })
  }
  const italics = (spans: Span[]) => {
    for (const g of groups(spans, (sp) => !!sp.italic)) {
      const t = g.spans.map((sp) => sp.text).join('')
      const [lead, core, trail] = ends(t)
      if (!g.key || !core) text(t)
      else {
        text(lead)
        mark('i', () => text(core))
        text(trail)
      }
    }
  }
  for (const g of groups(list, (sp) => !!sp.bold)) {
    const t = g.spans.map((sp) => sp.text).join('')
    const [lead, core, trail] = ends(t)
    if (!g.key || !core) italics(g.spans)
    else {
      italics(sliceSpans(g.spans, 0, lead.length))
      mark('b', () => italics(sliceSpans(g.spans, lead.length, lead.length + core.length)))
      italics(sliceSpans(g.spans, lead.length + core.length, t.length))
    }
  }
  // Each pair's marker, from a list of choices: bold '**'; italic '*' or '_', '_' first where it
  // touches bold's '**'; and failing those, none.
  const choices = new Map<number, string[]>()
  toks.forEach((t, n) => {
    if (!('pair' in t) || !t.open) return
    const touches = 'pair' in (toks[n - 1] ?? {}) || 'pair' in (toks[n + 1] ?? {})
    choices.set(t.pair, t.kind === 'b' ? ['**', ''] : touches ? ['_', '*', ''] : ['*', '_', ''])
  })
  const marker = (pair: number) => choices.get(pair)![0]
  const render = () => toks.map((t) => ('pair' in t ? marker(t.pair) : t.text)).join('')
  for (let round = 0; round < 3 * pairs + 3; round++) {
    const s = render()
    let at = 0
    let bad: number | null = null
    for (let n = 0; n < toks.length && bad === null; n++) {
      const t = toks[n]
      if (!('pair' in t)) {
        at += t.text.length
        continue
      }
      const m = marker(t.pair)
      if (m && !fits(m, t.open, at ? s[at - 1] : before, s[at + m.length] ?? after, s, at)) {
        // Bold that only clashes with an italic marker beside it keeps its stars; the italic changes.
        const side = [toks[n - 1], toks[n + 1]].find((o) => o && 'pair' in o && o.kind === 'i' && marker(o.pair) === '*')
        bad = t.kind === 'b' && side && 'pair' in side ? side.pair : t.pair
      }
      at += m.length
    }
    if (bad === null) return s
    choices.get(bad)!.shift()
  }
  for (const list of choices.values()) list.splice(0, list.length, '')
  return render()
}

/**
 * Whether a marker can open (or close) emphasis where it stands: CommonMark's flanking rules, with
 * '_' not inside a word, and no other marker of the same character right beside it.
 */
function fits(m: string, open: boolean, prev = '', next = '', s: string, at: number): boolean {
  const ch = m[0]
  if (s[at - 1] === ch || s[at + m.length] === ch) return false
  const space = (c: string) => !c || /\s/u.test(c)
  const punct = (c: string) => /[\p{P}\p{S}]/u.test(c)
  const left = !space(next) && (!punct(next) || space(prev) || punct(prev))
  const right = !space(prev) && (!punct(prev) || space(next) || punct(next))
  if (open) return left && (ch === '*' || !right || punct(prev))
  return right && (ch === '*' || !left || punct(next))
}

/** The spans' characters from `from` to `to`, keeping their styles. */
function sliceSpans(spans: Span[], from: number, to: number): Span[] {
  const out: Span[] = []
  let at = 0
  for (const sp of spans) {
    const piece = sp.text.slice(Math.max(0, from - at), Math.max(0, to - at))
    if (piece) out.push({ ...sp, text: piece })
    at += sp.text.length
  }
  return out
}

function groups<T>(list: Span[], keyOf: (sp: Span) => T): { key: T; spans: Span[] }[] {
  const out: { key: T; spans: Span[] }[] = []
  for (const sp of list) {
    const last = out[out.length - 1]
    if (last && last.key === keyOf(sp)) last.spans.push(sp)
    else out.push({ key: keyOf(sp), spans: [sp] })
  }
  return out
}
const outerSpace = (t: string) => t.match(/^(\s*)([\s\S]*?)(\s*)$/)!.slice(1, 4) as [string, string, string]
/** Spans without the white space at either end. */
function trimSpans(spans: Span[]): Span[] {
  const out = spans.map((sp) => ({ ...sp }))
  if (out.length) out[0].text = out[0].text.trimStart()
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.trimEnd()
  return out.filter((sp) => sp.text)
}

// ---- What the file says about itself ----------------------------------------------------------------

/** A title worth keeping: not empty, not a file name, not what a program fills in. */
export function cleanTitle(raw: string | undefined): string | undefined {
  const t = raw?.replace(/\s+/g, ' ').trim()
  if (!t || t.length > 200) return undefined
  if (/^(untitled|document\d*|title|microsoft (word|powerpoint)\b.*|.*\.(docx?|pdf|pages|rtf|txt|indd|qxd|odt|pptx?|tex|dvi|html?))$/i.test(t)) return undefined
  return t
}

/** A PDF date ("D:20190203040506+05'30'") as YYYY-MM-DD, the day as the file wrote it. */
export function pdfDate(raw: string | undefined): string | undefined {
  const m = raw?.match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?/)
  if (!m) return undefined
  const [y, mo, d] = [Number(m[1]), Number(m[2] ?? 1), Number(m[3] ?? 1)]
  if (y < 1980 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export const isoDate = (raw: string | undefined) => raw?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
