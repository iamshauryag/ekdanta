// The front matter every imported note gets: a title, when it was written, when it was imported,
// where it came from, and a kind only when the text makes one plain. No DOM, no file system.
import { applyPatch, joinFrontMatter, splitFrontMatter, splitWords } from '../../src/lib/frontmatter.ts'
import { cleanTag } from '../../src/lib/tags.ts'

/** A date as YYYY-MM-DD in local time. */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The text's own first heading (any level), without Markdown. */
export function firstHeading(md: string): string | undefined {
  const m = md.match(/^#{1,6}[ \t]+(.+?)[ \t#]*$/m)
  return m ? plain(m[1]) || undefined : undefined
}

/** Markdown emphasis, links and code ticks stripped from a line. */
const plain = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\\(.)/g, '$1')
    .trim()

/** "my_draft-final.docx" → "My draft final". */
export function titleFromFileName(name: string) {
  const stem = name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stem ? stem[0].toUpperCase() + stem.slice(1) : 'Imported note'
}

/** Words of prose, not counting Markdown syntax, URLs or HTML tags. */
export function countWords(md: string) {
  const text = md
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/[#>*_`~|[\]-]+/g, ' ')
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)?.length ?? 0
}

/**
 * Guess a kind only from kinds the writer has: a short post with hashtags reads as LinkedIn, a letter
 * that opens "Dear" or "Hi" as an email. Anything else gets no kind.
 */
export function guessPlatform(md: string, kindIds: string[]): string | undefined {
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const words = countWords(body)
  if (kindIds.includes('linkedin') && words > 0 && words < 300 && /(^|\s)#[\p{L}][\p{L}\p{N}_]+/u.test(body.replace(/^#{1,6}\s.*$/gm, ''))) return 'linkedin'
  const first = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^#{1,6}\s/.test(l))
  // "Dear Priya," / "Hi all" / "Hi," on a line of its own: a greeting, not a sentence that starts "Hi".
  if (kindIds.includes('email') && first && /^(dear|hi)\b(,|[ \t]+[^\n]{1,60})?$/i.test(first) && !/[.!?]\s+\S/.test(first)) return 'email'
  return undefined
}

export interface NoteMeta {
  title: string
  created: string
  imported: string
  source: string
  platform?: string
  /** Labels chosen while importing, added to the note's tags. */
  tags?: string[]
}

/**
 * Labels as the writer typed them, made into tags: no '#', no spaces, only letters, digits, _ - and /,
 * each once (ignoring case), at most 30.
 */
export function cleanLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const tag = cleanTag(v)
      .replace(/[^\p{L}\p{N}\p{M}_\-/]/gu, '')
      .replace(/\/{2,}/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .slice(0, 80)
    // A tag needs a letter: '#2024' isn't one.
    if (!/\p{L}/u.test(tag) || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
  }
  return out.slice(0, 30)
}

/**
 * The note's full text. A body that opens with the title as a top heading loses it (the app shows the
 * title above the text). Front matter the source already had stays; what it lacks is added.
 */
export function buildNote(markdown: string, m: NoteMeta): string {
  const fm = splitFrontMatter(markdown)
  const { meta, body, raw } = fm
  let text = body.replace(/^\n+/, '')
  const h1 = text.match(/^#[ \t]+(.+?)[ \t#]*\n/)
  if (h1 && plain(h1[1]) === m.title) text = text.slice(h1[0].length).replace(/^\n+/, '')
  const patch: Record<string, string | null> = {
    title: meta.title || m.title,
    created: meta.created || m.created,
    imported: m.imported,
    source: m.source,
  }
  // The kind chosen (its folder's) is what `platform` mirrors: a source's own value would only disagree with the folder.
  if (meta.platform || m.platform) patch.platform = m.platform || null
  patch.status = meta.status || 'imported'
  // Labels join the tags the source already had, which stay exactly as written (only a plain
  // `tags: a b` becomes a list); a label it already has, in any case, isn't added twice.
  const own = fm.lists.tags ?? (meta.tags ? splitWords(meta.tags) : [])
  // Compared as typed and as a label would be cleaned, so "V1.0" matches an existing "v1.0".
  const have = new Set([...own.map((t) => t.replace(/^#+/, '')), ...cleanLabels(own)].map((t) => t.toLowerCase()))
  const fresh = cleanLabels(m.tags).filter((t) => !have.has(t.toLowerCase()))
  const tags = fresh.length ? [...own, ...fresh] : null
  if (tags) patch.tags = tags.join(', ')
  // Ekdanta's keys first, in a fixed order, then whatever else the source had.
  const ordered = { ...patch } as Record<string, string>
  for (const [k, v] of Object.entries(meta)) if (!(k in ordered)) ordered[k] = v
  return joinFrontMatter(raw, applyPatch({}, ordered), text.trimEnd() + '\n', tags ? { lists: { tags } } : {})
}
