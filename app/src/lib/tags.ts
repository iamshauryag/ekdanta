// Tags: from front matter (`tags:`) and inline in the text (#idea, #writing/craft).
import { splitWords, type FrontMatter } from './frontmatter.ts'
import { isSpecialFile } from './special.ts'

/**
 * An inline tag: # then letters, digits, _ - or /, with at least one letter, at the start of a line
 * or after a space, '(' or an opening curly quote. So 'example.com/#x', 'a#b', '#123', '# Title',
 * href="#top" and [[#Heading]] are not tags.
 */
export const TAG = /(^|[\s(“‘])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu

/** Where each inline tag sits in a line of text: [start of '#', end, tag]. */
export function tagsInText(text: string): { from: number; to: number; tag: string }[] {
  const out: { from: number; to: number; tag: string }[] = []
  for (const m of text.matchAll(TAG)) {
    const tag = m[2]
    if (!/\p{L}/u.test(tag)) continue // #123 is a number, not a tag
    const from = m.index! + m[1].length
    out.push({ from, to: from + 1 + tag.length, tag })
  }
  return out
}

/**
 * The inline tags in a Markdown body. Code, headings, links (their text too, as in the editor),
 * [[wiki links]] and HTML tags can't hold one.
 */
export function inlineTags(body: string): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (const line of body.split('\n')) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    if (f) {
      fence = f[1]
      continue
    }
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line) || /^( {4}|\t)/.test(line)) continue
    const blank = (s: string) => ' '.repeat(s.length)
    const text = line
      .replace(/(`+)[^`]*?\1/g, blank)
      .replace(/\[\[[^\]]*\]\]/g, blank)
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, blank)
      .replace(/<[^>\s][^>]*>/g, blank)
    for (const t of tagsInText(text)) out.push(t.tag)
  }
  return out
}

/**
 * A front-matter key's tags. A list's items are tags; a plain value is split at commas and spaces,
 * as Obsidian reads `tags: craft essays`. The Properties chips and the vault's counts both read this.
 */
export function metaTags(fm: Pick<FrontMatter, 'meta' | 'lists'>, key = 'tags'): string[] {
  const items = fm.lists[key] ?? (fm.meta[key] ? splitWords(fm.meta[key]) : [])
  return items.map(cleanTag).filter(Boolean)
}

/** A document's tags: front-matter `tags` (and `tag`), then inline ones. '#' prefixes are dropped. */
export function docTags(fm: Pick<FrontMatter, 'meta' | 'lists' | 'body'>): string[] {
  const all = [...metaTags(fm, 'tags'), ...metaTags(fm, 'tag'), ...inlineTags(fm.body)].filter(Boolean)
  const seen = new Set<string>()
  return all.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
}

/** A tag as typed into a field: no '#', no spaces, no stray slashes. */
export const cleanTag = (t: string) =>
  t
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')

/** A tag and its parents: writing/craft → writing, writing/craft. */
export const withParents = (tag: string) => tag.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))

export interface TagCount {
  tag: string
  count: number
}

/** How many documents carry each tag. Nested tags count under their parents; case is merged (first seen wins). */
export function countTags(docs: string[][]): TagCount[] {
  const counts = new Map<string, TagCount>()
  for (const tags of docs) {
    const mine = new Set<string>()
    for (const tag of tags) for (const t of withParents(tag)) mine.add(t)
    const once = new Set<string>()
    for (const t of mine) {
      const key = t.toLowerCase()
      if (once.has(key)) continue
      once.add(key)
      const hit = counts.get(key)
      if (hit) hit.count++
      else counts.set(key, { tag: t, count: 1 })
    }
  }
  // Compare path by path, so writing/craft sits under writing and not under writing-tips.
  const parts = (t: TagCount) => t.tag.toLowerCase().split('/')
  return [...counts.values()].sort((a, b) => {
    const [x, y] = [parts(a), parts(b)]
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const c = x[i].localeCompare(y[i])
      if (c) return c
    }
    return x.length - y.length
  })
}

/** Does a document with these tags belong under `tag` (itself or a tag nested in it)? */
export function hasTag(tags: string[] | undefined, tag: string) {
  const want = tag.toLowerCase()
  return !!tags?.some((t) => {
    const l = t.toLowerCase()
    return l === want || l.startsWith(want + '/')
  })
}

/**
 * Whether a file's tags count in the vault's list. A template's tags are for the pieces made from it,
 * and ideas.md isn't listed among the pages, so a tag found only there would lead to no page.
 */
export const countsTags = (path: string) => !isSpecialFile(path) && !/^templates\//i.test(path)

/** The vault's tags, as the sidebar lists them. */
export function vaultTagCounts(files: { path: string; tags?: string[] }[]): TagCount[] {
  return countTags(files.filter((f) => countsTags(f.path)).map((f) => f.tags ?? []))
}
