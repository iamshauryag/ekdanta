// The vault's tags and how many documents carry each, from the cached listing (no extra reads).
import { editTags, metaTags, vaultTagCounts, type TagCount } from '../src/lib/tags.ts'
import { patchFrontMatter, joinDoc } from '../src/lib/frontmatter.ts'
import { editableFrontMatter, listFiles, writeDoc } from './vault.ts'

export async function listTags(): Promise<TagCount[]> {
  return vaultTagCounts(await listFiles())
}

/** Add and take away a note's front-matter tags, as they are on disk now. Returns its tags after. */
export async function editDocTags(rel: string, add: string[], remove: string[]): Promise<string[]> {
  const fm = await editableFrontMatter(rel, 'tag')
  const before = metaTags(fm)
  const after = editTags(before, add, remove)
  if (after.join('\n') !== before.join('\n')) await writeDoc(rel, joinDoc(patchFrontMatter(fm, { tags: after })), { reason: 'meta' })
  return after
}
