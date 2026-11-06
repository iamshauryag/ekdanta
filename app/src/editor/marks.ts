// Inline formatting as the writer means it.
//
// Strict Markdown won't count `**two words **` as bold (closing marks can't follow a space), and
// that state happens at every space typed at the end of bold text, or when bold and italic close
// together (`***`). So what's shown on the page, and what the toolbar shows as on, comes from this
// forgiving matcher: each opening mark pairs with the next matching closing mark on the line.
// `tidyMarks` then puts stray spaces outside the marks when the file is saved, so the file on disk
// is always plain, valid Markdown.

export type InlineMark = 'bold' | 'italic' | 'strike' | 'highlight' | 'underline'

export interface Span {
  mark: InlineMark
  /** The opening marks. */
  openFrom: number
  openTo: number
  /** The closing marks. */
  closeFrom: number
  closeTo: number
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c)
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c)

/** Ranges where marks don't count: code, link targets, [[links]], HTML other than <u>. */
function masked(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false)
  const cover = (re: RegExp, group = 0) => {
    for (const m of text.matchAll(re)) {
      const start = m.index! + (group ? m[0].indexOf(m[group]) : 0)
      const len = group ? m[group].length : m[0].length
      for (let i = start; i < start + len; i++) mask[i] = true
    }
  }
  cover(/(`+)[^`]*?\1/g)
  cover(/\]\(([^)]*)\)/g, 1)
  cover(/\[\[[^\]]*\]\]/g)
  cover(/\\./g)
  cover(/https?:\/\/\S+/g)
  return mask
}

/** Every formatted span on one line, with positions offset by `base`. */
export function scanLine(text: string, base = 0): Span[] {
  const mask = masked(text)
  const spans: Span[] = []
  const stack: { mark: InlineMark; delim: string; from: number; to: number }[] = []
  // A list item's or quote's own marker isn't formatting.
  const lead = text.match(/^\s*(?:[-*+] (?:\[[ xX]\] )?|\d+[.)] |>\s?)*/)![0].length

  const close = (delim: string, at: number): boolean => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].delim !== delim) continue
      // Something opened inside it and never closed: it was just a character.
      stack.length = k + 1
      const open = stack.pop()!
      if (at === open.to) return false // nothing between the marks
      spans.push({ mark: open.mark, openFrom: base + open.from, openTo: base + open.to, closeFrom: base + at, closeTo: base + at + delim.length })
      return true
    }
    return false
  }

  let i = lead
  while (i < text.length) {
    if (mask[i]) {
      i++
      continue
    }
    const rest = text.slice(i)
    if (rest.startsWith('<u>')) {
      stack.push({ mark: 'underline', delim: '</u>', from: i, to: i + 3 })
      i += 3
      continue
    }
    if (rest.startsWith('</u>')) {
      close('</u>', i)
      i += 4
      continue
    }
    const ch = text[i]
    if (ch === '*' || ch === '_' || ch === '~' || ch === '=') {
      let n = 1
      while (text[i + n] === ch) n++
      const before = text[i - 1]
      const after = text[i + n]
      if ((ch === '~' || ch === '=') && n !== 2) {
        i += n
        continue
      }
      // Underscores inside words (snake_case) are just underscores.
      if (ch === '_' && isWord(before) && isWord(after)) {
        i += n
        continue
      }
      let left = n
      // Close what's open first, innermost first ("***" can close italic and then bold).
      while (left > 0 && stack.length) {
        const top = stack[stack.length - 1]
        const fits = top.delim[0] === ch && top.delim.length <= left
        if (!fits) break
        // A closer straight after its opener isn't one ("****" while nothing is typed yet).
        const at = i + (n - left)
        if (!close(top.delim, at)) break
        left -= top.delim.length
      }
      // Whatever's left opens, if text follows it.
      if (left > 0 && !isSpace(text[i + n])) {
        const at = i + (n - left)
        if (ch === '~') stack.push({ mark: 'strike', delim: '~~', from: at, to: at + 2 })
        else if (ch === '=') stack.push({ mark: 'highlight', delim: '==', from: at, to: at + 2 })
        else {
          // "***" opens italic then bold, so a closing "***" closes bold, then italic.
          if (left === 1 || left >= 3) stack.push({ mark: 'italic', delim: ch, from: at, to: at + 1 })
          if (left >= 2) stack.push({ mark: 'bold', delim: ch + ch, from: at + (left >= 3 ? 1 : 0), to: at + (left >= 3 ? 3 : 2) })
        }
      }
      i += n
      continue
    }
    i++
  }
  return spans.sort((a, b) => a.openFrom - b.openFrom)
}

/** The spans of a kind around a position (the caret counts as inside up to the closing marks). */
export function spansAt(spans: Span[], pos: number): Span[] {
  return spans.filter((s) => pos >= s.openTo && pos <= s.closeFrom)
}

/**
 * Make formatting valid Markdown: spaces just inside the marks move outside them (`**a **` →
 * `**a** `), and marks with nothing between them go. Used when the file is written.
 */
export function tidyMarks(body: string): string {
  let fenced = false
  return body
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
      if (fenced || /^\s*(```|~~~)/.test(line)) return line
      for (let pass = 0; pass < 8; pass++) {
        const next = tidyOnce(line)
        if (next === line) break
        line = next
      }
      return line
    })
    .join('\n')
}

function tidyOnce(line: string): string {
  for (const s of scanLine(line)) {
    const inner = line.slice(s.openTo, s.closeFrom)
    const open = line.slice(s.openFrom, s.openTo)
    const close = line.slice(s.closeFrom, s.closeTo)
    if (!inner.trim()) return line.slice(0, s.openFrom) + inner + line.slice(s.closeTo)
    const lead = inner.match(/^\s*/)![0]
    const trail = inner.match(/\s*$/)![0]
    if (lead || trail) return line.slice(0, s.openFrom) + lead + open + inner.trim() + close + trail + line.slice(s.closeTo)
  }
  return line
}
