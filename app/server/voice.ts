// Voice profiles: a readable, editable description of how the writer writes on each platform,
// built from their exemplars. One Markdown file per platform in .ekdanta/voice/.
// The model proposes traits; code checks every quoted example against the source, and the
// writer's own rules are never touched by a rebuild.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { generate, parseJson, status } from './ai.ts'
import { META_DIR, listFiles, readDoc, splitFrontMatter, type FileEntry } from './vault.ts'
import { loadSettings } from './settings.ts'
import { kindName } from '../src/lib/kinds.ts'
import { isSpecialFile, isSpecialPath } from '../src/lib/special.ts'

const DIR = path.join(META_DIR, 'voice')
/** Below this many exemplars, recent unstarred pieces top up the sources. */
const ENOUGH = 3
const SOURCE_CHARS = 14_000

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

const platformOf = (f: FileEntry) => (f.platform ?? 'essay').toLowerCase()
const file = (platform: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(platform)) throw new Error('Unknown platform')
  return path.join(DIR, `${platform}.md`)
}

/**
 * Exemplars first; if there are too few, the most recent unstarred pieces fill in. A piece the writer
 * starred always counts, wherever it lives; templates, journals and excluded folders never fill in on their own.
 */
function sourcesFor(files: FileEntry[], platform: string, excluded: string[]) {
  const mine = files.filter((f) => platformOf(f) === platform && f.title !== 'Untitled')
  // The ideas list is a list, not a piece of writing: it never speaks for the writer's voice, starred or not.
  const starred = mine.filter((f) => f.exemplar && !isSpecialFile(f.path))
  const others = mine.filter((f) => !f.exemplar && !isSpecialPath(f.path, excluded)).sort((a, b) => b.mtime - a.mtime)
  return [...starred, ...others.slice(0, Math.max(0, ENOUGH - starred.length))]
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
  const { kinds, excludedFolders } = await loadSettings()
  for (const { id: platform } of kinds) {
    const sources = sourcesFor(files, platform, excludedFolders)
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
  const { kinds, excludedFolders } = await loadSettings()
  const sources = sourcesFor(files, platform, excludedFolders)
  const name = kindName(kinds, platform)
  if (!sources.length) throw new Error(`No ${name} pieces to learn from yet`)
  const texts: { path: string; text: string }[] = []
  let budget = SOURCE_CHARS
  for (const s of sources) {
    const { body } = splitFrontMatter(await readDoc(s.path))
    const text = body.trim().slice(0, Math.max(0, budget))
    if (!text) continue
    texts.push({ path: s.path, text })
    budget -= text.length
    if (budget <= 0) break
  }

  const { strong } = await status()
  if (!strong) throw new Error('No model available to read your writing')
  const existing = await readProfile(platform)
  const currentTraits = existing ? traitsOf(existing) : []
  const system = `You describe a writer's voice so that the writer can read it, agree or disagree, and edit it.
From the pieces given, write 6 to 10 traits of how this writer writes ${name} pieces. Each trait is ONE plain sentence, specific and checkable: sentence length and rhythm, how pieces open and close, punctuation habits, diction and register, how they use examples, what they tend to avoid.
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
  const lines = traits.map((t) => {
    const src = texts.find((x) => x.path === t.source) ?? texts.find((x) => t.example && norm(x.text).includes(norm(t.example)))
    const ok = t.example && src && norm(src.text).includes(norm(t.example).replace(/^["']|["']$/g, ''))
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
  const profile = await readProfile((platform ?? 'essay').toLowerCase()).catch(() => null)
  if (!profile) return ''
  const { body } = splitFrontMatter(profile)
  const lines = body
    .split('\n')
    .filter((l) => /^\s*[-*] \S/.test(l))
    .map((l) => l.trim())
  return lines.length ? `\n\nThe writer's own description of their voice here (follow it):\n${lines.join('\n')}` : ''
}
