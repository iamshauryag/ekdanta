// Voice profiles: a readable, editable description of how the writer writes on each platform,
// built from their exemplars. One Markdown file per platform in .ekdanta/voice/.
// The model proposes traits; code checks every quoted example against the source, and the
// writer's own rules are never touched by a rebuild.
//
// Sources: every piece the writer starred, then a sample of their other pieces on that platform spread
// across time and topics (sampleSources), up to MAX_SOURCES. Each is cut to an excerpt (its opening and
// its close, where voice shows most) so the whole set fits SOURCE_CHARS; a long essay can't crowd out the rest.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { META_DIR, listFiles, readDoc, splitFrontMatter, type FileEntry } from './vault.ts'
import { loadSettings } from './settings.ts'
import { vaultKinds } from './kinds.ts'
import { KIND_ID, kindName } from '../src/lib/kinds.ts'
import { isSpecialFile, isSpecialPath } from '../src/lib/special.ts'
import { isBrainPath } from '../src/lib/brain.ts'

const DIR = path.join(META_DIR, 'voice')
/** How many pieces a profile is built from: all starred ones, then a spread of the others up to this. */
export const MAX_SOURCES = 12
/** Characters of the writer's pieces the model reads to build a profile, in all. */
export const SOURCE_CHARS = 40_000
/** No excerpt is cut shorter than this, however many pieces there are. */
const PIECE_MIN = 1_500
/** Marks where an excerpt leaves text out. Quoted examples are checked against each side separately. */
const GAP = '\n\n[…]\n\n'

const RULES_HEADING = '## Your rules'
const RULES_NOTE = '<!-- Yours: rebuilding the profile never changes this section. -->'

export interface Source {
  path: string
  title: string
  exemplar: boolean
}

export interface VoiceSummary {
  platform: string
  exists: boolean
  /** Built from the current sources, none of which changed since. */
  upToDate: boolean
  built?: string
  sources: Source[]
  exemplars: number
}

// A note's kind, from its folder (listFiles); an Unfiled note has none, and no voice profile.
const platformOf = (f: FileEntry) => (f.platform ?? '').normalize('NFC').toLowerCase()
const file = (platform: string) => {
  if (!KIND_ID.test(platform)) throw new Error('Unknown platform')
  return path.join(DIR, `${platform}.md`)
}

/** What a piece is about, roughly: its tags, its sub-folder and the longer words of its title. */
function topics(f: FileEntry): string[] {
  const sub = f.folder.split('/').slice(1).join('/')
  const title = f.title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 5)
  return [...f.tags.map((t) => '#' + t.toLowerCase()), ...(sub ? ['/' + sub.toLowerCase()] : []), ...title]
}

/**
 * The pieces a profile is built from. Every piece the writer starred counts, wherever it lives (the ideas
 * list never does: it is a list, not writing). The others, never from templates, journals or excluded
 * folders, are sampled across time and topics: split into as many stretches of time as there are places
 * left, and from each the piece whose topics are least covered so far, the newest on a tie. Deterministic,
 * so the Voice page can tell whether a profile is up to date. Notes in the Brain hold other people's
 * words, so they never count, starred or not.
 */
export function sampleSources(files: FileEntry[], platform: string, excluded: string[], brain: string, max = MAX_SOURCES, exclude?: string): FileEntry[] {
  const mine = files.filter((f) => platformOf(f) === platform && f.title !== 'Untitled' && !isBrainPath(f.path, brain) && f.path !== exclude)
  const starred = mine.filter((f) => f.exemplar && !isSpecialFile(f.path)).sort((a, b) => b.mtime - a.mtime)
  const others = mine.filter((f) => !f.exemplar && !isSpecialPath(f.path, excluded)).sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
  const slots = Math.max(0, max - starred.length)
  if (others.length <= slots) return [...starred, ...others]
  const seen = new Map<string, number>()
  for (const f of starred) for (const t of topics(f)) seen.set(t, (seen.get(t) ?? 0) + 1)
  const picked: FileEntry[] = []
  for (let i = 0; i < slots; i++) {
    const bucket = others.slice(Math.floor((i * others.length) / slots), Math.floor(((i + 1) * others.length) / slots))
    let best = bucket[0]
    let bestScore = Infinity
    for (const f of bucket) {
      const keys = topics(f)
      const score = keys.length ? keys.reduce((n, t) => n + (seen.get(t) ?? 0), 0) / keys.length : 0
      if (score < bestScore) {
        best = f
        bestScore = score
      }
    }
    picked.push(best)
    for (const t of topics(best)) seen.set(t, (seen.get(t) ?? 0) + 1)
  }
  return [...starred, ...picked]
}

const sourcesFor = (files: FileEntry[], platform: string, excluded: string[], brain: string) => sampleSources(files, platform, excluded, brain)

/** A cut never leaves half a character: a surrogate pair split at either end is dropped. */
const whole = (s: string) => s.replace(/^[\uDC00-\uDFFF]/, '').replace(/[\uD800-\uDBFF]$/, '')

/** A piece cut to at most `cap` characters: its opening and its close, at paragraph or sentence ends where it can. */
export function excerpt(body: string, cap: number): string[] {
  const text = body.trim()
  if (text.length <= cap) return text ? [text] : []
  const headCap = Math.floor(cap * 0.65)
  let head = text.slice(0, headCap)
  const cut = Math.max(head.lastIndexOf('\n\n'), head.search(/[.!?。！？][^.!?。！？]*$/))
  if (cut > headCap * 0.5) head = head.slice(0, cut + 1)
  let tail = text.slice(text.length - (cap - head.length))
  const from = tail.indexOf('\n\n')
  if (from >= 0 && from < tail.length * 0.5) tail = tail.slice(from)
  return [whole(head).trim(), whole(tail).trim()].filter(Boolean)
}

/** Read the sources as excerpts, within a budget shared fairly between them. Starred pieces come first, so they are always in. */
async function readSources(sources: FileEntry[], budget: number) {
  const out: { path: string; title: string; exemplar: boolean; parts: string[] }[] = []
  const cap = Math.max(PIECE_MIN, Math.floor(budget / Math.max(1, sources.length)))
  let left = budget
  for (const s of sources) {
    if (left < 200) break
    const body = await readDoc(s.path)
      .then((raw) => splitFrontMatter(raw).body)
      .catch(() => '')
    const parts = excerpt(body, Math.min(cap, left))
    if (!parts.length) continue
    out.push({ path: s.path, title: s.title, exemplar: s.exemplar, parts })
    left -= parts.reduce((n, p) => n + p.length, 0)
  }
  return out
}

export async function readProfile(platform: string): Promise<string | null> {
  try {
    return await fs.readFile(file(platform), 'utf8')
  } catch {
    return null
  }
}

export async function writeProfile(platform: string, content: string) {
  await fs.mkdir(DIR, { recursive: true })
  await fs.writeFile(file(platform), content, 'utf8')
}

export async function summaries(): Promise<VoiceSummary[]> {
  const files = await listFiles()
  const out: VoiceSummary[] = []
  const { excludedFolders, brainFolder } = await loadSettings()
  const kinds = await vaultKinds()
  for (const { id: platform } of kinds) {
    const sources = sourcesFor(files, platform, excludedFolders, brainFolder)
    if (!sources.length) continue
    const profile = await readProfile(platform)
    const meta = profile ? splitFrontMatter(profile).meta : {}
    const builtFrom = (meta.sources ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const builtAt = meta.built ? Date.parse(meta.built) : 0
    const same = builtFrom.length === sources.length && sources.every((s) => builtFrom.includes(s.path))
    out.push({
      platform,
      exists: profile !== null,
      upToDate: profile !== null && same && sources.every((s) => s.mtime <= builtAt),
      built: meta.built,
      sources: sources.map((s) => ({ path: s.path, title: s.title, exemplar: s.exemplar })),
      exemplars: sources.filter((s) => s.exemplar).length,
    })
  }
  return out
}

interface Trait {
  trait: string
  example?: string
  source?: string
}

/** Propose a new profile. Nothing is written: the writer reviews it as a diff first. */
export async function buildProfile(platform: string): Promise<string> {
  const files = await listFiles()
  const { excludedFolders, brainFolder } = await loadSettings()
  const kinds = await vaultKinds()
  const sources = sourcesFor(files, platform, excludedFolders, brainFolder)
  const name = kindName(kinds, platform)
  if (!sources.length) throw new Error(`No ${name} pieces to learn from yet`)
  const texts = (await readSources(sources, SOURCE_CHARS)).map((t) => ({ path: t.path, parts: t.parts, text: t.parts.join(GAP) }))

  // The model layer is loaded only to build: sampling and evidence (used by tests and drafts) don't need it.
  const { generate, parseJson, status } = await import('./ai.ts')
  const { strong } = await status()
  if (!strong) throw new Error('No model available to read your writing')
  const existing = await readProfile(platform)
  const currentTraits = existing ? traitsOf(existing) : []
  const system = `You describe a writer's voice so that the writer can read it, agree or disagree, and edit it.
From the pieces given (excerpts of up to ${sources.length}, from different times and topics; […] marks text left out), write 6 to 10 traits of how this writer writes ${name} pieces. Each trait is ONE plain sentence, specific and checkable: sentence length and rhythm, how pieces open and close, punctuation habits, diction and register, how they use examples, what they tend to avoid.
For each trait, give one short example copied EXACTLY from the pieces (at most 14 words, no ellipses) and the file it came from.
Describe; don't praise. Don't invent anything the pieces don't show.${
    currentTraits.length
      ? `
The writer already has a profile (below). Keep each current trait that the pieces still support, copied word for word, with its example. Change or drop a trait only when the pieces contradict it or no longer show it, and add a trait only for something clear that's missing. Keep the current order.`
      : ''
  }
Return JSON: {"traits": [{"trait": "...", "example": "...", "source": "path/to/file.md"}]}`
  const prompt = `${currentTraits.length ? `Current profile:\n${currentTraits.join('\n')}\n\n` : ''}${texts.map((t) => `=== ${t.path}\n${t.text}`).join('\n\n')}`
  const raw = await generate(strong, { system, prompt, json: true, temperature: 0.3 })
  const traits = parseJson<{ traits: Trait[] }>(raw).traits.filter((t) => t.trait?.trim())
  if (!traits.length) throw new Error('The model returned no traits')

  // An example only stays if it really is the writer's words, from the file it names.
  const norm = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
  // Each side of an excerpt is checked on its own, so a "quote" that runs across a cut never passes.
  const quoted = (x: (typeof texts)[number], example: string) => x.parts.some((p) => norm(p).includes(example))
  const lines = traits.map((t) => {
    const example = t.example ? norm(t.example).replace(/^["']|["']$/g, '') : ''
    const src = texts.find((x) => x.path === t.source && example && quoted(x, example)) ?? texts.find((x) => example && quoted(x, example))
    const ok = Boolean(example && src)
    const name = src ? path.posix.basename(src.path, '.md') : ''
    return `- ${t.trait.trim()}${ok ? `\n  > ${norm(t.example!).replace(/^["']|["']$/g, '')} — [[${name}]]` : ''}`
  })

  const now = new Date().toISOString()
  return `---
platform: ${platform}
built: ${now}
sources: ${sources.map((s) => s.path).join(', ')}
---

## Traits

${lines.join('\n')}

${yourRules(existing)}`
}

/** The traits section of a profile, each trait with its example line. */
function traitsOf(profile: string) {
  const body = splitFrontMatter(profile).body
  const start = body.indexOf('## Traits')
  const end = body.indexOf(RULES_HEADING)
  if (start < 0) return []
  return body
    .slice(start + '## Traits'.length, end < 0 ? undefined : end)
    .split('\n')
    .filter((l) => l.trim())
}

/** The writer's section, carried over verbatim (or started empty). */
function yourRules(existing: string | null) {
  const i = existing?.indexOf(RULES_HEADING) ?? -1
  if (existing && i >= 0) return existing.slice(i).trimEnd() + '\n'
  return `${RULES_HEADING}\n\n${RULES_NOTE}\n`
}

/** The profile as instructions for a help request: traits without their examples, plus the writer's rules. */
export async function voiceForPrompt(platform?: string): Promise<string> {
  // An Unfiled note has no kind, so no profile: its help follows the general guidance.
  if (!platform) return ''
  const profile = await readProfile(platform.toLowerCase()).catch(() => null)
  if (!profile) return ''
  const { body } = splitFrontMatter(profile)
  const lines = body
    .split('\n')
    .filter((l) => /^\s*[-*] \S/.test(l))
    .map((l) => l.trim())
  return lines.length ? `\n\nThe writer's own description of their voice here (follow it):\n${lines.join('\n')}` : ''
}

/**
 * Evidence of how the writer writes on a platform, for writing a whole draft (server/draft.ts): the profile
 * whole (traits, the lines they were quoted from, the writer's rules), excerpts of a spread of their pieces
 * there (starred first), and the texts of all their pieces there for measuring habits. `exclude` is the
 * piece being drafted, which never counts as evidence of itself.
 */
export async function voiceEvidence(
  platform: string,
  opts: { exclude?: string; budget?: number; max?: number } = {},
): Promise<{ profile: string | null; pieces: { path: string; title: string; exemplar: boolean; text: string }[]; all: string[]; count: number }> {
  const id = platform.normalize('NFC').toLowerCase()
  if (!id) return { profile: null, pieces: [], all: [], count: 0 }
  const files = await listFiles()
  const { excludedFolders, brainFolder } = await loadSettings()
  const sources = sampleSources(files, id, excludedFolders, brainFolder, opts.max ?? 8, opts.exclude)
  const pieces = (await readSources(sources, opts.budget ?? 18_000)).map((p) => ({ path: p.path, title: p.title, exemplar: p.exemplar, text: p.parts.join(GAP) }))
  // Habits are measured over more pieces than the model reads: up to 40 of the newest and the starred.
  const forHabits = sampleSources(files, id, excludedFolders, brainFolder, 40, opts.exclude)
  const all = (
    await Promise.all(
      forHabits.map((f) =>
        readDoc(f.path).then(
          (raw) => splitFrontMatter(raw).body.trim(),
          () => '',
        ),
      ),
    )
  ).filter(Boolean)
  const profile = KIND_ID.test(id) ? await readProfile(id) : null
  return { profile: profile ? splitFrontMatter(profile).body.trim() : null, pieces, all, count: forHabits.length }
}
