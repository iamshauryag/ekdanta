// The vault's tags and how many documents carry each, from the cached listing (no extra reads).
import { vaultTagCounts, type TagCount } from '../src/lib/tags.ts'
import { listFiles } from './vault.ts'

export async function listTags(): Promise<TagCount[]> {
  return vaultTagCounts(await listFiles())
}
