// A PDF's text, put back in reading order as Markdown. A PDF only says where each run of text is drawn,
// so the structure is rebuilt from positions: runs on one baseline make a line, a gutter down the
// middle of a page makes two columns, lines that repeat at the top or bottom of most pages are running
// headers and footers, a larger size than the body text is a heading, and the spacing and indents
// between lines say where a paragraph ends. Pure functions: no pdf.js, no file system, so it can be
// tested with made-up pages.

/** One run of text: x is its left edge and y its baseline, from the top of the page, in points. */
export interface PdfItem {
  str: string
  x: number
  y: number
  w: number
  size: number
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
}

// Bullets as drawn, including the private-use code points Word's Symbol and Wingdings bullets come out as.
// Dashes other than '-' open dialogue far more often than lists, so they're text.
const BULLET = /^([•◦▪▫●○■□►▸▹‣⁃∙➢➤✓✔❖\uF0A7\uF0B7\uF076\uF0D8\uF0FC\uF0A8\uF06E\uF0E0]\s*|[-*·]\s+)(?=\S)/u
// Numbered items only; "a)" and "(a)" stay as written, since Markdown has no lettered lists.
const NUMBERED = /^(\d{1,3}[.)]|\(\d{1,3}\))\s+(?=\S)/
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
function toLine(items: PdfItem[], page: number, col: number): Line {
  let text = ''
  const cells: { text: string; x: number }[] = []
  const runs: { text: string; x: number }[] = []
  let prev: PdfItem | null = null
  const bySize = new Map<number, number>()
  for (const it of items) {
    // Fake bold: the same run drawn twice, a hair apart.
    if (prev && it.str === prev.str && Math.abs(it.x - prev.x) < 0.3 * it.size) continue
    const gap = prev ? it.x - (prev.x + prev.w) : 0
    const space = !!prev && gap > 0.15 * it.size && !/\s$/.test(prev.str) && !/^\s/.test(it.str)
    if (!prev || gap > 2 * Math.max(it.size, prev.size)) cells.push({ text: it.str, x: it.x })
    else cells[cells.length - 1].text += (space ? ' ' : '') + it.str
    if (!prev || space) runs.push({ text: it.str, x: it.x })
    else runs[runs.length - 1].text += it.str
    text += (space ? ' ' : '') + it.str
    const size = Math.round(it.size * 2) / 2
    bySize.set(size, (bySize.get(size) ?? 0) + it.str.length)
    prev = it
  }
  const last = items[items.length - 1]
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    x: items[0].x,
    right: last.x + last.w,
    y: Math.min(...items.map((it) => it.y)),
    size: [...bySize].sort((a, b) => b[1] - a[1])[0][0],
    page,
    col,
    cells: tidyCells(cells),
    runs: tidyCells(runs),
  }
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
  const edge = new Set<Line>()
  const byPage = new Map<number, Line[]>()
  for (const l of lines) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l])
  for (const [p, list] of byPage) {
    const h = pages[p].height
    const on = [...list].sort((a, b) => a.y - b.y)
    // The first and last two lines of a page, if they sit in its margins.
    for (const l of [...on.slice(0, 2), ...on.slice(-2)]) if (l.y < h * 0.1 || l.y > h * 0.9) edge.add(l)
  }

  const numbers = pageNumbers([...edge])
  const pagesWith = new Map<string, Set<number>>()
  for (const l of edge) if (!numbers.has(l)) pagesWith.set(key(l), (pagesWith.get(key(l)) ?? new Set()).add(l.page))
  // Odd and even pages often carry different headers, so a little under half the pages is enough.
  const enough = Math.max(3, Math.ceil(pages.length * 0.4))
  const running = new Set([...pagesWith].filter(([, on]) => on.size >= enough).map(([k]) => k))
  const removed: Removed = { running: [], pageNumbers: numbers.size }
  for (const k of running) removed.running.push({ text: [...edge].find((l) => key(l) === k)!.text, pages: pagesWith.get(k)!.size })
  return { lines: lines.filter((l) => !numbers.has(l) && !(edge.has(l) && running.has(key(l)))), removed }
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

type Block = { kind: 'p'; text: string } | { kind: 'h'; level: number; text: string } | { kind: 'li'; ordered: string | null; text: string; x: number } | { kind: 'table'; rows: string[][] }

function toMarkdown(lines: Line[], words: Set<string>, rejoined: string[]): { markdown: string; tables: number } {
  if (!lines.length) return { markdown: '', tables: 0 }
  // The body size: the size most of the text is set in.
  const weight = new Map<number, number>()
  for (const l of lines) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length)
  const bodySize = [...weight].sort((a, b) => b[1] - a[1])[0][0]

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

  // Headings: clearly larger than the body, and short. Sizes rank them: the largest is level 1 only if
  // it's used once (a title), otherwise headings start at level 2.
  const isHeading = (l: Line) => l.size >= bodySize * 1.15 && l.text.length <= 150 && l.text.split(' ').length <= 15 && /\p{L}{2}/u.test(l.text) && !/[,;]$/.test(l.text)
  const headingSizes = [...new Set(lines.filter(isHeading).map((l) => Math.round(l.size)))].sort((a, b) => b - a)
  const titleOnce = headingSizes.length > 0 && lines.filter((l) => isHeading(l) && Math.round(l.size) === headingSizes[0]).length === 1
  const levelOf = (size: number) => Math.min(3, headingSizes.indexOf(Math.round(size)) + (titleOnce ? 1 : 2))

  const tableish = (l: Line) => l.cells.length >= 3
  const blocks: Block[] = []
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
    if (tableish(l)) {
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
    if (isHeading(l)) {
      // A heading that wraps onto a second line is one heading.
      if (b?.kind === 'h' && prev && isHeading(prev) && prev.size === l.size && prev.page === l.page && l.y > prev.y && l.y - prev.y < l.size * 1.6) b.text += ' ' + l.text
      else blocks.push({ kind: 'h', level: levelOf(l.size), text: l.text })
      prev = l
      continue
    }
    const open = b && (b.kind === 'p' || b.kind === 'li') && prev && !isHeading(prev) ? b : null
    const continues = !!open && continuesFrom(prev!, l, open, { left: lefts.get(colKey(l)) ?? l.x, right: rights.get(colKey(prev!)) ?? prev!.right, pitch })
    const bullet = l.text.match(BULLET)
    const numbered = l.text.match(NUMBERED)
    // A numbered line in the middle of a sentence is the sentence going on ("… see chapter\n3. Then …"),
    // unless it lines up under the list item before it.
    const underItem = open?.kind === 'li' && l.x <= open.x + 0.5 * l.size
    const listStart = bullet || (numbered && (underItem || !(continues && !ENDS_SENTENCE.test(prev!.text))))
    if (listStart) {
      const m = (bullet ?? numbered)!
      blocks.push({ kind: 'li', ordered: bullet ? null : m[1].replace(/[().]/g, ''), text: l.text.slice(m[0].length), x: l.x })
    } else if (continues) open!.text = join(open!.text, l.text, words, rejoined)
    else blocks.push({ kind: 'p', text: l.text })
    prev = l
  }
  return { markdown: render(blocks), tables }
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
function continuesFrom(prev: Line, l: Line, block: Block, col: { left: number; right: number; pitch: number }): boolean {
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
  // A short line that ends a sentence ends the paragraph.
  if (ENDS_SENTENCE.test(prev.text) && prev.right < col.right - Math.max(4 * l.size, (col.right - col.left) * 0.15)) return false
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
    rejoined.push(m[2] + rest)
    return a.slice(0, -1) + b
  }
  if (/[—/]$/.test(a)) return a + b
  return a + ' ' + b
}

// ---- Markdown ------------------------------------------------------------------------------------

/** Text that Markdown would read as markup, escaped. */
export function escapeMd(s: string): string {
  return s.replace(/([\\`*_[\]])/g, '\\$1').replace(/<(?=[A-Za-z/!?])/g, '\\<')
}

/** A paragraph that would start a heading, quote, list or rule, escaped at its start. */
// A rule or fence of its own ("---", "~~~", "==="), or one opening a paragraph, would be read as markup
// (or, first in a note, as front matter). '*' and '_' are already escaped everywhere.
const escapeStart = (s: string) => s.replace(/^(#{1,6}(\s|$)|>|[-+](\s|$)|-{2,}|~{3,}|=+)/, '\\$1').replace(/^(\d+)([.)])(\s|$)/, '$1\\$2$3')

function render(blocks: Block[]): string {
  let out = ''
  blocks.forEach((b, i) => {
    let text: string
    if (b.kind === 'h') text = `${'#'.repeat(b.level)} ${escapeMd(b.text)}`
    else if (b.kind === 'li') text = `${b.ordered && /^\d+$/.test(b.ordered) ? `${b.ordered}.` : '-'} ${escapeMd(b.text)}`
    else if (b.kind === 'table') {
      const width = Math.max(...b.rows.map((r) => r.length))
      const row = (r: string[]) => '| ' + Array.from({ length: width }, (_, n) => escapeMd(r[n] ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |'
      text = [row(b.rows[0]), '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |', ...b.rows.slice(1).map(row)].join('\n')
    } else text = escapeStart(escapeMd(b.text))
    // List items sit on consecutive lines; everything else is separated by a blank line.
    if (i) out += b.kind === 'li' && blocks[i - 1].kind === 'li' ? '\n' : '\n\n'
    out += text
  })
  return out ? out + '\n' : ''
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
