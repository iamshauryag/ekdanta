// The vault's tags and how many documents carry each, from the cached listing (no extra reads).
import { editTags, metaTags, vaultTagCounts, type TagCount } from '../src/lib/tags.ts'
import { patchFrontMatter, joinDoc, splitFrontMatter } from '../src/lib/frontmatter.ts'
import { HttpError } from './net.ts'
import { StaleWrite, editableFrontMatter, listFiles, readWithMtime, writeDoc } from './vault.ts'

export async function listTags(): Promise<TagCount[]> {
  return vaultTagCounts(await listFiles())
}

/**
 * Add and take away a note's front-matter tags, as they are on disk now. Returns its tags after.
 * The write only lands on the version it was worked out from: if the file changes in between (in
 * Obsidian, say), it's read again and the change worked out afresh, and after a few tries it's a 409.
 */
export async function editDocTags(rel: string, add: string[], remove: string[], read = readWithMtime): Promise<string[]> {
  for (let tries = 0; tries < 3; tries++) {
    const disk = await read(rel)
    if (!disk) throw new HttpError(404, 'Not in the vault')
    const fm = splitFrontMatter(disk.content)
    if (fm.readonly) await editableFrontMatter(rel, 'tag') // throws the 409 that says why
    const before = metaTags(fm)
    const after = editTags(before, add, remove)
    if (after.join('\n') === before.join('\n')) return after
    try {
      await writeDoc(rel, joinDoc(patchFrontMatter(fm, { tags: after })), { reason: 'meta', baseMtime: disk.mtime })
      return after
    } catch (e) {
      if (!(e instanceof StaleWrite)) throw e
    }
  }
  throw new HttpError(409, 'It kept changing on disk, so its tags were left as they are. Try again.')
}
