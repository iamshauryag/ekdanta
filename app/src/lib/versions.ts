// Version history: the rules shared by the server (what to keep) and the panel (how to show it).
// No DOM here, so it can be tested with node:test.
import { diffWordsWithSpace } from 'diff'
import { splitAfter } from './split.ts'

export interface VersionEntry {
  /** Also the snapshot's file name (without .md): its time, made safe for a file name. */
  id: string
  /** ISO time the text was as it is in this version. */
  at: string
  /** Words in the body (front matter left out). */
  words: number
  /** Why it was taken: 'autosave', 'saved by you', 'before restore', 'changed outside Ekdanta'… */
  reason: string
  /** A name the writer gave it. Named versions are never pruned. */
  name?: string
  hash: string
}

/** A version as the panel lists it: with its change from the version before it. */
export interface VersionRow extends VersionEntry {
  added: number
  removed: number
}

export const HOUR = 3600_000
export const DAY = 24 * HOUR
/** Unnamed versions kept per document, at most. */
export const MAX_UNNAMED = 200
/** Above this, a version is shown as plain text only (a word diff would be too slow). */
export const BIG = 1024 * 1024

/** An id for a snapshot taken at `at`: the ISO time with the colons swapped out, so it works as a file name everywhere. */
export const versionId = (at: Date) => at.toISOString().replace(/:/g, '-')
export const isVersionId = (id: string) => /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z(-\d+)?$/.test(id)

/** Front matter split from the body, as the file has it (fence lines included). */
export function splitDoc(content: string): { front: string; body: string } {
  const m = content.match(/^---\n[\s\S]*?\n---\n?/)
  if (!m) return { front: '', body: content }
  return { front: m[0], body: content.slice(m[0].length) }
}

export const countWords = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

/** Words added and removed going from `before` to `after` (bodies only). */
export function wordDelta(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 }
  // A word diff of a huge file is slow; the change in count is enough there.
  if (before.length + after.length > BIG) {
    const d = countWords(after) - countWords(before)
    return { added: Math.max(0, d), removed: Math.max(0, -d) }
  }
  let added = 0
  let removed = 0
  for (const part of diffWordsWithSpace(before, after)) {
    if (part.added) added += countWords(part.value)
    else if (part.removed) removed += countWords(part.value)
  }
  return { added, removed }
}

/** How many sentences a stretch of text holds (a fragment with no full stop counts as one). */
export function sentenceCount(text: string) {
  return splitAfter(text.trim(), /([.!?…])["'”’)]*\s+/g).filter((s) => /[\p{L}\p{N}]/u.test(s)).length
}

/**
 * Which versions to keep: every named one, everything from the last 24 hours, the newest of each
 * hour for a week, the newest of each day before that, and no more than MAX_UNNAMED unnamed ones.
 * Entries may come in any order; the result is oldest first.
 */
export function retain(entries: VersionEntry[], now: number): VersionEntry[] {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const keep = new Set<VersionEntry>()
  const newestIn = new Map<string, VersionEntry>()
  for (const e of sorted) {
    const t = Date.parse(e.at)
    const age = now - t
    if (e.name || age <= DAY) keep.add(e)
    // Later entries overwrite earlier ones, so each bucket ends up with its newest.
    else if (age <= 7 * DAY) newestIn.set('h' + Math.floor(t / HOUR), e)
    else newestIn.set('d' + Math.floor(t / DAY), e)
  }
  for (const e of newestIn.values()) keep.add(e)
  let out = sorted.filter((e) => keep.has(e))
  const unnamed = out.filter((e) => !e.name)
  if (unnamed.length > MAX_UNNAMED) {
    const drop = new Set(unnamed.slice(0, unnamed.length - MAX_UNNAMED))
    out = out.filter((e) => !drop.has(e))
  }
  return out
}

/** Versions grouped by the day they were taken, newest day first and newest first within a day. */
export function byDay<T extends { at: string }>(rows: T[], now = new Date()): { label: string; rows: T[] }[] {
  const dayOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  const today = dayOf(now)
  const yesterday = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const groups: { key: string; label: string; rows: T[] }[] = []
  for (const r of [...rows].sort((a, b) => b.at.localeCompare(a.at))) {
    const d = new Date(r.at)
    const key = dayOf(d)
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) {
      const label =
        key === today
          ? 'Today'
          : key === yesterday
            ? 'Yesterday'
            : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
      g = { key, label, rows: [] }
      groups.push(g)
    }
    g.rows.push(r)
  }
  return groups.map(({ label, rows }) => ({ label, rows }))
}

/** "+120 / −30 words" ("+120 words" if nothing went), or "0 words" when only the front matter (or nothing countable) changed. */
export function deltaLabel(added: number, removed: number) {
  if (!added && !removed) return '0 words'
  const parts = [added && `+${added.toLocaleString()}`, removed && `−${removed.toLocaleString()}`].filter(Boolean)
  return `${parts.join(' / ')} words`
}

export type DiffPart = { kind: 'same' | 'ins' | 'del'; text: string }

/** A word diff from `from` to `to`, merged into runs. */
export function wordDiff(from: string, to: string): DiffPart[] {
  const out: DiffPart[] = []
  for (const p of diffWordsWithSpace(from, to)) {
    const kind = p.added ? 'ins' : p.removed ? 'del' : 'same'
    const last = out[out.length - 1]
    if (last?.kind === kind) last.text += p.value
    else out.push({ kind, text: p.value })
  }
  return out
}
