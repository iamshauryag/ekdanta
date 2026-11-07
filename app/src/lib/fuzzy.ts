// Fuzzy matching for the quick switcher: the query's letters must appear in order ("unfin" finds
// "The unfinished room"), and a match that starts words or runs letters together ranks higher.
// Shared, DOM-free and tested in fuzzy.test.ts.

/**
 * Lower case without accents, one character for one character, so positions in the folded string
 * are positions in the original. A character that wouldn't fold to exactly one (ß, İ) stays as it is.
 */
export function fold(s: string): string {
  let out = ''
  for (const ch of s) {
    const f = ch
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
    out += f.length === ch.length ? f : ch
  }
  return out
}

export interface FuzzyMatch {
  score: number
  /** Indexes into the target of the matched characters, for highlighting. */
  positions: number[]
}

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c)
/** Does a word start at i: the first character, after a space or punctuation, or a capital after a lower-case letter. */
function wordStart(target: string, i: number) {
  if (i === 0) return true
  const prev = target[i - 1]
  const ch = target[i]
  if (!isWordChar(prev)) return isWordChar(ch)
  return /\p{Ll}/u.test(prev) && /\p{Lu}/u.test(ch)
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const MATCH = 1
const WORD_START = 8
const RUN = 5
const AT_START = 6
const GAP = 0.15
const MAX_GAP_PENALTY = 3

/**
 * The best way to find the query's letters, in order, in the target; null if they aren't all there.
 * Spaces in the query are ignored. Case and accents don't matter.
 */
export function fuzzy(query: string, target: string): FuzzyMatch | null {
  const q = fold(query).replace(/\s+/g, '')
  if (!q) return { score: 0, positions: [] }
  const t = fold(target)
  const n = q.length
  const m = t.length
  if (n > m) return null
  // Quick check: is it a subsequence at all? Most targets fail here.
  for (let i = 0, j = 0; i < n; i++, j++) {
    j = t.indexOf(q[i], j)
    if (j < 0) return null
  }
  // best[i][j]: the best score with query[i] matched at target[j]; from[i][j]: where query[i-1] was.
  const NEG = -Infinity
  const best: Float64Array[] = []
  const from: Int32Array[] = []
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(m).fill(NEG)
    const back = new Int32Array(m).fill(-1)
    for (let j = i; j < m; j++) {
      if (t[j] !== q[i]) continue
      const bonus = MATCH + (wordStart(target, j) ? WORD_START : 0)
      if (i === 0) {
        row[j] = bonus + (j === 0 ? AT_START : 0) - Math.min(MAX_GAP_PENALTY, j * GAP)
        continue
      }
      const prev = best[i - 1]
      let top = NEG
      let at = -1
      for (let k = i - 1; k < j; k++) {
        if (prev[k] === NEG) continue
        const s = prev[k] + (k === j - 1 ? RUN : -Math.min(MAX_GAP_PENALTY, (j - k - 1) * GAP))
        if (s > top) {
          top = s
          at = k
        }
      }
      if (at >= 0) {
        row[j] = top + bonus
        back[j] = at
      }
    }
    best.push(row)
    from.push(back)
  }
  let score = NEG
  let end = -1
  for (let j = 0; j < m; j++)
    if (best[n - 1][j] > score) {
      score = best[n - 1][j]
      end = j
    }
  if (end < 0) return null
  const positions: number[] = []
  for (let i = n - 1, j = end; i >= 0; j = from[i][j], i--) positions.unshift(j)
  // Shorter targets win ties; a whole or leading match wins outright.
  const whole = fold(query).trim()
  if (t === whole) score += 100
  else if (t.startsWith(whole)) score += 20
  else if (whole && [...t.matchAll(new RegExp(escape(whole), 'g'))].some((m) => wordStart(target, m.index))) score += 15
  return { score: score - m * 0.01, positions }
}

export interface SwitchEntry {
  path: string
  title: string
  folder: string
  aliases?: string[]
}

export interface Ranked<T> {
  file: T
  score: number
  /** What matched: the title (highlight `positions` in it), an alias, or the path. */
  field: 'title' | 'alias' | 'path'
  alias?: string
  positions: number[]
}

/** Files that match the query, best first: a title match counts most, then an alias, then the path (weighted down, so
 * a title wins unless an alias or the path matches much better). */
export function rankFiles<T extends SwitchEntry>(query: string, files: readonly T[], limit = 50): Ranked<T>[] {
  if (!query.trim()) return []
  const out: Ranked<T>[] = []
  for (const file of files) {
    let top: Ranked<T> | null = null
    const title = fuzzy(query, file.title)
    if (title) top = { file, score: title.score, field: 'title', positions: title.positions }
    for (const alias of file.aliases ?? []) {
      const a = fuzzy(query, alias)
      if (a && (!top || a.score * 0.75 > top.score)) top = { file, score: a.score * 0.75, field: 'alias', alias, positions: [] }
    }
    const p = fuzzy(query, file.path.replace(/\.md$/, ''))
    if (p && (!top || p.score * 0.6 > top.score)) top = { file, score: p.score * 0.6, field: 'path', positions: [] }
    if (top) out.push(top)
  }
  return out.sort((a, b) => b.score - a.score || a.file.title.localeCompare(b.file.title)).slice(0, limit)
}

/**
 * What the switcher shows before anything is typed: the writer's recent documents (most recent
 * first, skipping the open one and any that are gone), filled up with the most recently changed.
 */
export function recentFiles<T extends { path: string; mtime?: number }>(recent: readonly string[], files: readonly T[], open: string | null, limit = 8): T[] {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const out: T[] = []
  const seen = new Set<string>(open ? [open] : [])
  for (const p of recent) {
    const f = byPath.get(p)
    if (f && !seen.has(p)) {
      out.push(f)
      seen.add(p)
    }
    if (out.length >= limit) return out
  }
  const rest = files.filter((f) => !seen.has(f.path)).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
  return out.concat(rest.slice(0, limit - out.length))
}

/** Put a path at the front of a recent list, without repeats, keeping at most `max`. */
export const pushRecent = (list: readonly string[], item: string, max = 20) => [item, ...list.filter((x) => x !== item)].slice(0, max)

/** Titles that more than one file has, so the switcher can show their folders. */
export function duplicateTitles(files: readonly { title: string }[]): Set<string> {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const f of files) {
    const t = fold(f.title.trim())
    if (seen.has(t)) dup.add(t)
    seen.add(t)
  }
  return dup
}

/**
 * The command palette's rule, the same as the "/" menu's: every word typed starts some word of the
 * text ("thin" finds "Thinking Space", "pan out" finds "Panel: Outline").
 */
export function wordsMatch(query: string, text: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  const hay = fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  return words.every((w) => hay.some((h) => h.startsWith(w)))
}

/** Commands for the palette: those matching the query, the recently used first (most recent first), the rest in their usual order. */
export function orderCommands<T extends { id: string }>(commands: readonly T[], recent: readonly string[], text: (c: T) => string, query: string): T[] {
  const shown = commands.filter((c) => !query.trim() || wordsMatch(query, text(c)))
  const rank = (c: T) => {
    const i = recent.indexOf(c.id)
    return i < 0 ? Infinity : i
  }
  return shown
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c)
}
