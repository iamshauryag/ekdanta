// Folders that hold material rather than the writer's own finished prose: templates, a journal,
// notes on sources, exports. Recall, voice profiles and filing by kind leave them out, as they do
// any folder the writer excludes in settings. Shared by the app and the server, so no DOM here.

export const SPECIAL_FOLDERS = ['templates', 'journal', 'brain', 'sources', 'exports', '_inbox']

/** A vault-relative path in a standard form: forward slashes, no leading or trailing slash, lower case. */
const norm = (p: string) =>
  p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+|^\/+|\/+$/g, '')
    .toLowerCase()

/**
 * Is this path (a file or a folder) inside a special folder, or inside one of the writer's excluded
 * folders? Special folders count only at the top of the vault; an excluded folder can be nested
 * ("archive/2019"). Matching is by whole folder name and ignores case.
 */
export function isSpecialPath(path: string, excluded: readonly string[] = []): boolean {
  const p = norm(path)
  if (!p) return false
  const top = p.split('/')[0]
  if (SPECIAL_FOLDERS.includes(top)) return true
  return excluded.some((folder) => {
    const f = typeof folder === 'string' ? norm(folder) : ''
    return !!f && (p === f || p.startsWith(f + '/'))
  })
}

/** A paragraph that is only a template's writing prompt, `*Prompt: …*`: guidance, not the writer's words. */
export function isPromptParagraph(text: string): boolean {
  return /^([*_])Prompt:[^*_]*\1$/i.test(text.trim())
}
