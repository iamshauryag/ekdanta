// The vault's kinds of writing, read from its folders. A kind and a top-level folder are one thing
// (src/lib/kinds.ts says how they're matched): this module lists the folders, pairs them with the
// settings saved for each kind, and makes a folder whenever a kind is made.
//
// Settings keep every kind the writer ever had (its guidance, length, template, voice), keyed by its
// id. Only the ones whose folder is there are shown; the rest wait, and come back with their folder.
//
// vault.ts uses this module, so it must never import vault.ts.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { VAULT } from './paths.ts'
import { checkBrainWith, loadSettings, saveSettings, type Settings } from './settings.ts'
import { HttpError } from './net.ts'
import { DEFAULT_KINDS, cleanKinds, findKind, isSetApartFolder, kindDisplayName, kindsFromFolders, type Kind, type KindScope } from '../src/lib/kinds.ts'

/** What keeps a folder from being a kind besides the fixed set-apart ones: the writer's excluded folders and the Brain's. */
export const scopeOf = (s: Pick<Settings, 'excludedFolders' | 'brainFolder'>): KindScope => ({ excluded: s.excludedFolders, brain: s.brainFolder })

export const kindScope = async () => scopeOf(await loadSettings())

/** The vault's top-level folders that are kinds, as spelled on disk. */
export async function kindFolders(scope: KindScope): Promise<string[]> {
  const entries = await fs.readdir(VAULT, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory() && !isSetApartFolder(e.name, scope)).map((e) => e.name)
}

/** The writer's kinds now: one per top-level folder, with its saved settings. Reads the vault's top level (cheap). */
export async function vaultKinds(): Promise<Kind[]> {
  const s = await loadSettings()
  return kindsFromFolders(s.kinds, await kindFolders(scopeOf(s)))
}

// Settings check a new Brain folder against the kinds there really are, not the ones saved.
checkBrainWith(vaultKinds)

/**
 * The kinds an idea or a spark may be pitched for: the writer's, or in a vault with no folders yet,
 * the suggestions (Essay, LinkedIn post…), one of which is made when a piece is started for it.
 */
export async function offeredKinds(): Promise<Kind[]> {
  const own = await vaultKinds()
  return own.length ? own : DEFAULT_KINDS
}

// Every change to the kinds reads the saved list, may make or remove folders, then saves the list:
// one at a time, so two changes at once (an import and Break it down, say) never lose each other's.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

const fold = (s: string) => s.normalize('NFC').toLowerCase()
const exists = (abs: string) =>
  fs.stat(abs).then(
    () => true,
    () => false,
  )

/**
 * The saved list with `kinds` put in (by id, in the order given, then the rest as they were). A
 * kind that takes a folder takes it for good: any other saved kind that names that folder (one
 * whose own folder went, say) lets go of it, its settings kept under a free name (blog-2/), so
 * the folder can't come back as that other kind.
 */
async function merged(saved: readonly Kind[], kinds: readonly Kind[]): Promise<Kind[]> {
  const ids = new Set(kinds.map((k) => k.id))
  const held = new Set(kinds.map((k) => fold(k.folder)))
  const rest: Kind[] = []
  for (const k of saved) {
    if (ids.has(k.id)) continue
    if (!held.has(fold(k.folder))) {
      rest.push(k)
      continue
    }
    const used = (f: string) => held.has(fold(f)) || [...kinds, ...saved, ...rest].some((o) => o !== k && fold(o.folder) === fold(f))
    // blog → blog-2; blog-2 → blog-3 (not blog-2-2).
    const stem = k.folder.replace(/-\d+$/, '') || k.folder
    let free = `${stem}-2`
    for (let n = 3; used(free) || (await exists(path.join(VAULT, free))); n++) free = `${stem}-${n}`
    rest.push({ ...k, folder: free })
  }
  return [...kinds, ...rest]
}

async function ensureNow(wanted: readonly Kind[]): Promise<Kind[]> {
  if (!wanted.length) return []
  const s = await loadSettings()
  let visible = await vaultKinds()
  const adding: Kind[] = []
  for (const w of wanted) {
    if (findKind(visible, w.id) || adding.some((a) => a.id === w.id)) continue
    const saved = findKind(s.kinds, w.id)
    const base = saved ?? w
    const taken = (f: string) => isSetApartFolder(f, scopeOf(s)) || [...visible, ...adding].some((k) => fold(k.folder) === fold(f))
    // A kind that comes back from a folder it was moved to while away (blog-2/, scripts-2/) takes its
    // natural one again when that's free: the built-in folder, else the name without the -2. A new
    // kind keeps the folder it was given, and one saved as "Book chapters" keeps that.
    const stem = base.folder.replace(/-\d+$/, '')
    const natural = saved && stem !== base.folder ? (findKind(DEFAULT_KINDS, w.id)?.folder ?? stem) : base.folder
    const first = [natural, stem, base.folder].find((f) => f && !taken(f)) ?? natural
    let folder = first
    for (let n = 2; taken(folder); n++) folder = `${first}-${n}`
    adding.push({ ...base, folder })
  }
  if (adding.length) {
    for (const k of adding) await fs.mkdir(path.join(VAULT, k.folder), { recursive: true })
    await saveSettings({ kinds: await merged(s.kinds, [...visible, ...adding]) })
    visible = await vaultKinds()
  }
  return wanted.map((w) => findKind(visible, w.id)).filter((k): k is Kind => !!k)
}

/**
 * Make sure each of these kinds is one of the writer's, with a folder. A kind already listed is
 * returned as it is. One that isn't (a suggestion such as Essay, a kind Break it down or Sparks
 * needs, one the writer just named) gets its folder made: the settings saved for its id when there
 * are some (it comes back as it was), else the ones given. A folder name another kind or a set-apart
 * folder already has gets -2, -3. Returns the kinds, in the order asked, as now listed.
 */
export const ensureKinds = (wanted: readonly Kind[]): Promise<Kind[]> => serial(() => ensureNow(wanted))

/** The kind with this id as one of the writer's, or one they had before, or a suggestion: what kindFor would make, without making it. */
export async function knownKind(id: string): Promise<Kind | undefined> {
  if (!id) return undefined
  return findKind(await vaultKinds(), id) ?? findKind((await loadSettings()).kinds, id) ?? findKind(DEFAULT_KINDS, id)
}

/**
 * The kind with this id, made if needed: one of the writer's, else one they had before or a
 * suggestion (Essay, LinkedIn post…), whose folder is made now. Undefined for an id that's none of
 * these. Callers check everything else first, so a refused request never leaves a folder behind.
 */
export async function kindFor(id: string): Promise<Kind | undefined> {
  const base = await knownKind(id)
  return base ? (await ensureKinds([base]))[0] : undefined
}

/** Does this folder hold anything of the writer's? Finder's .DS_Store doesn't count, nor do empty folders. */
async function holdsFiles(abs: string): Promise<boolean> {
  for (const e of await fs.readdir(abs, { withFileTypes: true }).catch(() => [])) {
    if (e.name === '.DS_Store') continue
    if (!e.isDirectory() || (await holdsFiles(path.join(abs, e.name)))) return true
  }
  return false
}

/** Take away an empty folder: .DS_Store files and empty folders inside it go; rmdir refuses anything else. */
async function removeEmpty(abs: string) {
  for (const e of await fs.readdir(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name)
    if (e.isDirectory()) await removeEmpty(p)
    else if (e.name === '.DS_Store') await fs.unlink(p)
  }
  await fs.rmdir(abs)
}

/**
 * Settings → Kinds saved the list. The list is the vault's folders, so what changed is applied to them:
 * - a kind that's new to the list gets its folder (ensureKinds);
 * - every other kind keeps its folder and name (those change by renaming, which moves the folder),
 *   and takes the rest of what was sent: guidance, length, template, document defaults, order.
 * A kind missing from what was sent is kept: the app may not have seen it yet (a folder just made
 * in Finder). Removing a kind is removeKind, asked for by its id.
 */
export const saveVisibleKinds = (value: unknown): Promise<Kind[]> =>
  serial(async () => {
    const incoming = cleanKinds(value) ?? []
    const s = await loadSettings()
    const visible = await vaultKinds()
    const kept = incoming.flatMap((k) => {
      const v = findKind(visible, k.id)
      return v ? [{ ...k, name: v.name, folder: v.folder }] : []
    })
    await saveSettings({ kinds: await merged(s.kinds, kept) })
    const added = incoming.filter((k) => !findKind(visible, k.id))
    if (added.length) await ensureNow(added)
    // The order the writer gave, now that every kind in it has a folder; kinds they didn't send keep their place after.
    const now = await vaultKinds()
    const order = incoming.map((k) => findKind(now, k.id)).filter((k): k is Kind => !!k)
    await saveSettings({ kinds: await merged((await loadSettings()).kinds, order) })
    return vaultKinds()
  })

/**
 * Remove a kind, which is removing its folder: only an empty one (checked again now, and rmdir
 * never takes a folder with anything in it), else 409. Its settings are kept, for if it comes back.
 */
export const removeKind = (id: string): Promise<Kind[]> =>
  serial(async () => {
    const kind = findKind(await vaultKinds(), id)
    if (!kind) throw new HttpError(404, 'No such kind')
    const abs = path.join(VAULT, kind.folder)
    const refuse = () => new HttpError(409, `${kind.folder}/ still has notes in it, so ${kindDisplayName(kind.name)} can’t be removed. Move them to another kind first.`)
    if (await holdsFiles(abs)) throw refuse()
    await removeEmpty(abs).catch(() => {
      throw refuse()
    })
    return vaultKinds()
  })

/** Save one kind's settings (after its folder was renamed in the app, say), keeping the others and its place. */
export const saveKind = (kind: Kind): Promise<Kind[]> =>
  serial(async () => {
    const s = await loadSettings()
    const at = s.kinds.findIndex((k) => k.id === kind.id)
    // The others in their order, any that named this folder letting go of it; then this one back in its place.
    const others = (
      await merged(
        s.kinds.filter((k) => k.id !== kind.id),
        [kind],
      )
    ).slice(1)
    await saveSettings({ kinds: at < 0 ? [...others, kind] : [...others.slice(0, at), kind, ...others.slice(at)] })
    return vaultKinds()
  })
