// Plain text and Markdown. Text arrives in whatever encoding its computer used (UTF-8, Windows-1252,
// UTF-16 from Notepad), often hard-wrapped at 72 or 80 columns, sometimes with underlined
// ("Setext") headings. It leaves as UTF-8 Markdown: paragraphs reflowed, headings with #.
import jschardet from 'jschardet'

/** Read bytes as text, whatever the encoding. */
export function decodeText(buf: Uint8Array): { text: string; encoding: string } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' }
  // UTF-16 without a byte-order mark: ASCII text leaves every other byte zero.
  const sample = buf.subarray(0, 4096)
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) i % 2 ? oddZero++ : evenZero++
  const half = sample.length / 2
  if (sample.length >= 4 && oddZero > half * 0.3 && evenZero < half * 0.05) return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le' }
  if (sample.length >= 4 && evenZero > half * 0.3 && oddZero < half * 0.05) return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'utf-16be' }
  // Valid UTF-8 is almost certainly UTF-8.
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }
  } catch {
    /* some single-byte encoding */
  }
  const guess = jschardet.detect(Buffer.from(buf.subarray(0, 64 * 1024)))
  const name = (guess.encoding ?? '').toLowerCase()
  // Short Western text is where detectors guess wildly; Windows-1252 (a superset of Latin-1) is the
  // safe reading unless the detector is sure of something else.
  const western = !name || name === 'ascii' || name === 'iso-8859-1' || name === 'windows-1252' || guess.confidence < 0.8
  const encoding = western ? 'windows-1252' : name
  try {
    return { text: new TextDecoder(encoding).decode(buf), encoding }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' }
  }
}

/** Line endings to \n, no byte-order mark, no trailing spaces on lines (except a Markdown line break). */
export function normalizeNewlines(text: string) {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

const BLOCK_START = /^(\s*([-*+]|\d+[.)])\s|#{1,6}\s|>|\||```|~~~|\s{4}|\t)/

/**
 * Plain text to Markdown: underlined headings become # headings, hard-wrapped paragraphs are joined
 * into one line each, and short-lined paragraphs (a poem, an address) keep their line breaks.
 */
export function textToMarkdown(text: string): string {
  const lines = normalizeNewlines(text)
    .replace(/\f/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
  const blocks: string[][] = []
  let cur: string[] = []
  for (const line of lines) {
    if (!line.trim()) {
      if (cur.length) blocks.push(cur)
      cur = []
    } else cur.push(line)
  }
  if (cur.length) blocks.push(cur)

  const out: string[] = []
  for (const block of blocks) {
    // Setext: "Title" over "=====" (or "-----" for a second-level heading), possibly mid-block.
    const parts: string[][] = [[]]
    for (let i = 0; i < block.length; i++) {
      const next = block[i + 1]
      if (next !== undefined && /^\s{0,3}(=+|-+)\s*$/.test(next) && block[i].trim() && !BLOCK_START.test(block[i]) && next.trim().length >= Math.min(3, block[i].trim().length)) {
        if (parts[parts.length - 1].length) parts.push([])
        parts[parts.length - 1].push(`${next.trim()[0] === '=' ? '#' : '##'} ${block[i].trim()}`)
        parts.push([])
        i++
      } else parts[parts.length - 1].push(block[i])
    }
    for (const part of parts.filter((p) => p.length)) out.push(reflow(part))
  }
  return out.join('\n\n') + '\n'
}

/** One paragraph's lines: joined if they were wrapped to a width, kept apart if they're short on purpose. */
function reflow(lines: string[]): string {
  if (lines.length === 1) return lines[0]
  // Lists, quotes, code and tables keep their lines as they are.
  if (lines.some((l) => BLOCK_START.test(l)) || /^#{1,6}\s/.test(lines[0])) return lines.join('\n')
  const widths = lines.map((l) => l.length)
  const max = Math.max(...widths)
  const wrapped = max >= 40 && widths.slice(0, -1).every((w) => w >= max * 0.6)
  if (wrapped) return lines.map((l) => l.trim()).join(' ')
  // Short lines on purpose: a Markdown line break keeps each one.
  return lines.map((l, i) => (i < lines.length - 1 ? l + '\\' : l)).join('\n')
}

/** A Kindle's "My Clippings.txt": highlights from every book, separated by lines of =. */
export function isKindleClippings(name: string, text: string) {
  if (/my clippings/i.test(name)) return true
  const seps = text.match(/^={10}\s*$/gm)?.length ?? 0
  return seps >= 2 && /^- (Your )?(Highlight|Note|Bookmark)\b/m.test(text)
}

/** Kindle clippings kept as they are, line for line, for the Brain to sort into books. */
export function clippingsToMarkdown(text: string) {
  return '```text\n' + normalizeNewlines(text).replace(/```/g, "'''").trimEnd() + '\n```\n'
}
