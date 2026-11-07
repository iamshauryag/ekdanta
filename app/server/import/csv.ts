// A spreadsheet export (.csv, .tsv) as a Markdown table. Long ones are cut at a few hundred rows:
// past that a table stops being something to read, and the whole file stays attached.
import Papa from 'papaparse'

export const MAX_ROWS = 500

export interface CsvResult {
  markdown: string
  rows: number
  /** Rows left out of the table (they're in the attached file). */
  dropped: number
}

/** `attachment`: the name the whole file is attached under, linked when rows are left out. */
export function csvToMarkdown(text: string, opts: { maxRows?: number; attachment?: string; delimiter?: string } = {}): CsvResult {
  const max = opts.maxRows ?? MAX_ROWS
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy', delimiter: opts.delimiter ?? '' })
  const data = parsed.data.filter((r) => Array.isArray(r) && r.some((c) => String(c).trim()))
  if (!data.length) return { markdown: '', rows: 0, dropped: 0 }
  const width = Math.max(...data.map((r) => r.length))
  const cell = (v: unknown) =>
    String(v ?? '')
      .trim()
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '<br>')
  const row = (r: string[]) => '| ' + Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ') + ' |'
  const [head, ...body] = data
  const shown = body.slice(0, max)
  const dropped = body.length - shown.length
  const lines = [row(head.map((h, i) => h || `Column ${i + 1}`)), '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |', ...shown.map(row)]
  let markdown = lines.join('\n') + '\n'
  if (dropped > 0) {
    const more = `${dropped.toLocaleString('en-US')} more ${dropped === 1 ? 'row is' : 'rows are'}`
    markdown += `\n*The first ${max.toLocaleString('en-US')} rows are shown. ${more} in ${opts.attachment ? `[the full file](${opts.attachment})` : 'the original file'}.*\n`
  }
  return { markdown, rows: body.length, dropped }
}
