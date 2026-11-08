// Break it down: the server side. A plan for which of the writer's passages each short post draws on,
// then new drafts made from it, linked back to the piece. The piece itself is only ever read.
//
// The help ceiling is enforced here, not on the page:
//   0  off.
//   1  Recall: no model. The plan comes from the piece's own sections; drafts hold the writer's passages.
//   2–3  the model picks passages and names an angle (a direction, never a line to paste). Drafts hold
//        only the writer's passages, each checked against the piece; anything else sent is dropped.
//   4  as 3, and the plan may suggest one opening line per post, used only if the writer keeps it.
//   5  as 4, and the model may adapt the wording of the writer's passages for the platform, keeping
//      their words and adding no ideas (checked in code); such a draft says so in its front matter.
//   6+ (a "whole drafts" level, when there is one) the adaptation may add the lines that join the
//      passages into a finished post, still within the platform's limits.
import type { IncomingMessage } from 'node:http'
import path from 'node:path'
import { HttpError, local } from './net.ts'
import { readCapped, stopSignal } from './assistant.ts'
import { loadSettings, saveSettings } from './settings.ts'
import { existingDoc, freePath, listFiles, readDoc, slugify, splitFrontMatter, writeDoc, type FileEntry } from './vault.ts'
import { joinFrontMatter } from '../src/lib/frontmatter.ts'
import { isSpecialPath } from '../src/lib/special.ts'
import { isBrainPath } from '../src/lib/brain.ts'
import { newKind, type Kind } from '../src/lib/kinds.ts'
import { sentences as sentenceCount, words } from '../src/lib/assistant.ts'
import {
  MAX_POSTS,
  WORDING,
  findFormat,
  findPassage,
  fit,
  formatsFor,
  joinParts,
  kindFor,
  measure,
  adaptationProblems,
  quotedBody,
  sectionPlan,
  slotsFor,
  tooShort,
  unitName,
  unitsOf,
  wikiLinkTo,
  asMarkdown,
  type Format,
  type Passage,
  type PlannedPost,
  type Target,
  type Unit,
  type Habit,
  type FormatInfo,
  type PlanReply,
  type PostRequest,
  type Created,
  type Options,
  type CreateReply,
} from '../src/lib/breakdown.ts'

type Handler = (req: IncomingMessage, url: URL) => Promise<unknown>

// ---- What the ceiling allows ------------------------------------------------------------------

export interface Allowance {
  level: number
  /** Who plans: nobody (off), the piece's sections (no model), or the model. */
  plan: 'off' | 'sections' | 'model'
  /** The plan may suggest an opening line per post. */
  opening: boolean
  /** How far the model may change the wording of the drafts. */
  adapt: 'none' | 'passages' | 'whole'
}

export function allowance(ceiling: number): Allowance {
  const level = Math.max(0, Math.round(Number(ceiling) || 0))
  if (level <= 0) return { level: 0, plan: 'off', opening: false, adapt: 'none' }
  if (level === 1) return { level, plan: 'sections', opening: false, adapt: 'none' }
  return { level, plan: 'model', opening: level >= 4, adapt: level >= 6 ? 'whole' : level === 5 ? 'passages' : 'none' }
}

/** What each level means here, in the writer's words, for the sheet. */
export function levelNote(a: Allowance): string {
  if (a.plan === 'off') return 'Help is off (help ceiling 0), so Break it down is too.'
  if (a.plan === 'sections') return 'Help ceiling 1: the plan follows your own sections, with no model, and the posts start as your own words.'
  if (a.adapt === 'whole') return `Help ceiling ${a.level}: the model plans, suggests openings, and can draft each post from your passages. Drafts it wrote say so.`
  if (a.adapt === 'passages') return 'Help ceiling 5: the model plans and suggests openings, and can adapt the wording of your passages for each platform. Adapted drafts say so.'
  if (a.opening) return 'Help ceiling 4: the model picks your passages and an angle, and suggests an opening line you can keep. The rest is your own words.'
  return `Help ceiling ${a.level}: the model picks your passages and an angle for each post. The posts start as your own words.`
}

// ---- Dependencies, so tests can run without a model ---------------------------------------------

export interface BreakdownDeps {
  ceiling?: number
  /** The model: given the prompt, its raw answer. Leave out to use the writer's own. */
  ask?: (system: string, prompt: string) => Promise<string>
  /** No model answers. */
  noModel?: boolean
  voice?: (kind: string) => Promise<string>
  /** The writer pressed Cancel (the request went away): no more model calls, and nothing is written. */
  signal?: AbortSignal
}

/** The request was cancelled; the route answers it with nothing (the page has stopped listening). */
export class Cancelled extends Error {}
const checkStop = (deps: BreakdownDeps) => {
  if (deps.signal?.aborted) throw new Cancelled('Cancelled')
}

async function model(deps: BreakdownDeps): Promise<((system: string, prompt: string) => Promise<string>) | null> {
  if (deps.noModel) return null
  if (deps.ask) {
    const ask = deps.ask
    return async (system, prompt) => {
      checkStop(deps)
      const out = await ask(system, prompt)
      checkStop(deps)
      return out
    }
  }
  const { generate, status } = await import('./ai.ts')
  const strong = (await status()).strong
  if (!strong) return null
  return async (system, prompt) => {
    checkStop(deps)
    const out = await generate(strong, { system, prompt, json: true, temperature: 0.4, maxTokens: 4096, signal: deps.signal })
    checkStop(deps)
    return out
  }
}

async function voiceOf(deps: BreakdownDeps, kind: string): Promise<string> {
  try {
    if (deps.voice) return await deps.voice(kind)
    const { voiceForPrompt } = await import('./voice.ts')
    return await voiceForPrompt(kind)
  } catch {
    return ''
  }
}

// ---- The piece ----------------------------------------------------------------------------------

/** The piece as it is on disk: its title and its paragraphs. */
async function readPiece(doc: unknown): Promise<{ rel: string; title: string; units: Unit[] }> {
  const rel = await existingDoc(doc)
  const { meta, body } = splitFrontMatter(await readDoc(rel))
  return { rel, title: meta.title?.trim() || path.posix.basename(rel, '.md'), units: unitsOf(body) }
}

// ---- The writer's habits on a platform ----------------------------------------------------------

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

/** How long the writer's own past posts of this kind run: starred ones first, then the latest, up to 12. */
async function habitFor(f: Format, kind: Kind | undefined, files: FileEntry[], skip: string, excluded: string[], brain: string): Promise<Omit<Habit, 'voice'>> {
  if (!kind) return { pieces: 0, length: 0 }
  const mine = files.filter((x) => (x.platform ?? '').toLowerCase() === kind.id && x.path !== skip && !isSpecialPath(x.path, excluded) && !isBrainPath(x.path, brain))
  const pick = [...mine.filter((x) => x.exemplar), ...mine.filter((x) => !x.exemplar).sort((a, b) => b.mtime - a.mtime)].slice(0, 12)
  const lengths: number[] = []
  for (const x of pick) {
    const body = splitFrontMatter(await readDoc(x.path).catch(() => '')).body
    const text = unitsOf(body)
      .map((u) => u.text)
      .join('\n\n')
    if (text.trim()) lengths.push(measure(f, text))
  }
  return { pieces: lengths.length, length: median(lengths) }
}

async function formatInfo(kinds: Kind[], doc: string, deps: BreakdownDeps): Promise<FormatInfo[]> {
  const files = await listFiles()
  const { excludedFolders, brainFolder } = await loadSettings()
  const out: FormatInfo[] = []
  for (const f of formatsFor(kinds)) {
    const kind = kindFor(f, kinds)
    const planned = kind ?? newKind(f.newKind ?? f.label, kinds)
    const h = await habitFor(f, kind, files, doc, excludedFolders, brainFolder)
    out.push({
      id: f.id,
      label: f.label,
      shape: f.shape,
      measure: f.measure,
      limit: f.limit,
      unit: unitName(f),
      hard: f.hard,
      ...(f.parts ? { parts: f.parts } : {}),
      kind: planned?.name ?? f.label,
      folder: planned?.folder ?? '',
      adds: !kind,
      habit: { ...h, voice: kind ? Boolean(await voiceOf(deps, kind.id)) : false },
    })
  }
  return out
}

// ---- Options: what the sheet shows before planning ----------------------------------------------

export async function breakdownOptions(doc: unknown, deps: BreakdownDeps = {}): Promise<Options> {
  const piece = await readPiece(doc)
  const settings = await loadSettings()
  const a = allowance(deps.ceiling ?? settings.ceiling)
  return {
    title: piece.title,
    level: a.level,
    note: levelNote(a),
    allows: { plan: a.plan, opening: a.opening, adapt: a.adapt },
    short: tooShort(piece.units),
    words: piece.units.reduce((n, u) => n + words(u.text), 0),
    formats: await formatInfo(settings.kinds, piece.rel, deps),
  }
}

// ---- The plan -----------------------------------------------------------------------------------

export interface PlanRequest {
  doc: string
  targets: Target[]
}

const ANGLE_WORDS = 25
const PROMPT_CHARS = 40_000

/** An angle as the plan keeps it: one line, a direction of at most 25 words. */
export const cleanAngle = (s: unknown) => {
  let t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["“]|["”]$/g, '')
    .trim()
  // A longer one is cut short, never dropped: it may be the writer's own.
  if (words(t) > ANGLE_WORDS) t = /\s/.test(t) ? t.split(' ').slice(0, ANGLE_WORDS).join(' ') + '…' : Array.from(t).slice(0, 60).join('') + '…'
  return Array.from(t).slice(0, ANGLE_MAX).join('')
}

/** The longest angle, in characters (the plan's angle box takes no more). */
export const ANGLE_MAX = 200

/** An opening line as the plan keeps it: one sentence that fits the format (a thread: its first part). Else ''. */
export function cleanOpening(s: unknown, f: Format): string {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["“]|["”]$/g, '')
    .trim()
  if (!t || sentenceCount(t) > 1 || words(t) > 30) return ''
  if (f.measure !== 'words' && measure(f, t) > Math.min(f.limit, 280)) return ''
  return t
}

function limitLine(f: Format, h: Habit | undefined) {
  const unit = unitName(f)
  const cap = f.shape === 'thread' ? `each part at most ${f.limit} ${unit}, at most ${f.parts} parts` : f.hard ? `at most ${f.limit.toLocaleString('en-US')} ${unit}` : `about ${f.limit} ${unit}`
  const habit = h?.pieces ? `; the writer's own ${f.label}s run about ${h.length.toLocaleString('en-US')} ${unit}` : ''
  return `${f.label} (${cap}${habit})`
}

export async function planBreakdown(input: PlanRequest, deps: BreakdownDeps = {}): Promise<PlanReply> {
  if (!input || typeof input !== 'object' || !Array.isArray(input.targets)) throw new HttpError(400, 'Choose what to make first')
  const piece = await readPiece(input.doc)
  const settings = await loadSettings()
  const a = allowance(deps.ceiling ?? settings.ceiling)
  if (a.plan === 'off') return { kind: 'off', message: levelNote(a) }
  const short = tooShort(piece.units)
  if (short) return { kind: 'short', message: short }
  const kinds = settings.kinds
  const slots = slotsFor(input.targets, kinds)
  if (!slots.length) throw new HttpError(400, 'Choose what to make first')
  const targets: Target[] = []
  for (const f of slots) {
    const last = targets[targets.length - 1]
    if (last?.format === f.id) last.count++
    else targets.push({ format: f.id, count: 1 })
  }
  const notes: string[] = []
  if (input.targets.reduce((n, t) => n + Math.max(1, Math.round(Number(t?.count) || 1)), 0) > slots.length) notes.push(`A plan makes at most ${MAX_POSTS} posts at once.`)

  const ask = a.plan === 'model' ? await model(deps) : null
  if (!ask) {
    if (a.plan === 'model') notes.push('No model is available, so the plan follows your own sections.')
    return { kind: 'plan', level: a.level, by: 'sections', units: piece.units, posts: sectionPlan(piece.units, targets, kinds), notes }
  }

  // Each format's limits and the writer's own habits on that platform, never generic platform advice.
  const info = new Map((await formatInfo(kinds, piece.rel, deps)).map((x) => [x.id, x]))
  const uniq = [...new Map(slots.map((f) => [f.id, f])).values()]
  const voices: string[] = []
  for (const f of uniq) {
    const kind = kindFor(f, kinds)
    const v = kind ? await voiceOf(deps, kind.id) : ''
    if (v) voices.push(`For ${f.label}s:${v.replace(/^\s*\n+The writer's own description of their voice here \(follow it\):/, '')}`)
  }
  const system = `You are Ekdanta, a writing collaborator built on restraint. The writer owns every word.
The writer has a long piece and wants to break it down into shorter posts for other platforms. You plan; you never write the posts.
For each post: "passages": the parts of the piece it draws on, each copied EXACTLY from one numbered paragraph (whole sentences, the writer's own words, with the paragraph's number as "p"); and "angle": what the post is about or leads with, as a short direction to the writer (at most 20 words), never a line they could paste.${
    a.opening ? `\nAlso give "opening": one suggested first line for the post, one sentence in the writer's voice, short enough for the platform.` : ''
  }
Each post must stand on its own and draw on different passages from the others where the piece allows. Choose passages that fit the platform's limit together. Use the writer's habits and voice notes below, not general advice about the platform. Answer in the language of the piece.
Return JSON: {"posts": [{"target": 1, "angle": "...", ${a.opening ? '"opening": "...", ' : ''}"passages": [{"p": 3, "text": "..."}]}]}`
  let budget = PROMPT_CHARS
  let read = 0
  const lines: string[] = []
  for (const [i, u] of piece.units.entries()) {
    const head = u.heading && piece.units[i - 1]?.heading !== u.heading ? `## ${u.heading}\n` : ''
    const line = `${head}[${u.id}] ${u.text}`
    budget -= line.length + 2
    if (budget < 0) break
    lines.push(line)
    read++
  }
  const numbered = lines.join('\n\n')
  // A very long piece: the model reads its start, and the writer is told where it stopped (they can add passages from the rest).
  if (read < piece.units.length) notes.push(`Your piece is long, so the model read only the first ${read} of its ${piece.units.length} paragraphs. You can add passages from the rest yourself.`)
  const wanted = targets.map((t, i) => `${i + 1}. ${t.count} × ${limitLine(findFormat(kinds, t.format)!, info.get(t.format)?.habit)}`).join('\n')
  const prompt = `Title: ${JSON.stringify(piece.title)}\n\nMake exactly these posts ("target" is the number on the left):\n${wanted}\n${voices.length ? `\n${voices.join('\n\n')}\n` : ''}\nThe piece, by paragraph:\n"""\n${numbered}\n"""`

  let raw: string
  try {
    raw = await ask(system, prompt)
  } catch (e) {
    if (e instanceof Cancelled) throw e
    return { kind: 'error', message: `The model didn’t answer: ${(e as Error).message}` }
  }
  const posts = checkPlan(raw, piece.units, targets, kinds, a)
  if (posts.dropped) notes.push(`${posts.dropped} passage${posts.dropped === 1 ? '' : 's'} the model gave weren’t in your piece word for word, so they were left out.`)
  if (!posts.posts.length) {
    notes.push('The model’s plan didn’t hold up, so this one follows your own sections.')
    return { kind: 'plan', level: a.level, by: 'sections', units: piece.units, posts: sectionPlan(piece.units, targets, kinds), notes }
  }
  return { kind: 'plan', level: a.level, by: 'model', units: piece.units, posts: posts.posts, notes }
}

/** The model's plan, checked: every passage found in the piece word for word, at most the posts asked for, openings only where allowed. */
export function checkPlan(raw: string, units: Unit[], targets: Target[], kinds: Kind[], a: Allowance): { posts: PlannedPost[]; dropped: number } {
  let parsed: { posts?: unknown }
  try {
    const start = raw.indexOf('{')
    parsed = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1))
  } catch {
    return { posts: [], dropped: 0 }
  }
  const list = Array.isArray(parsed.posts) ? parsed.posts : []
  const left = targets.map((t) => t.count)
  const posts: PlannedPost[] = []
  let dropped = 0
  for (const item of list as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue
    const ti = Math.round(Number(item.target)) - 1
    if (!(ti >= 0 && ti < targets.length) || left[ti] <= 0) continue
    const f = findFormat(kinds, targets[ti].format)
    if (!f) continue
    const passages: Passage[] = []
    for (const p of Array.isArray(item.passages) ? (item.passages as Record<string, unknown>[]) : []) {
      const found = findPassage(units, String((p as Record<string, unknown>)?.text ?? (typeof p === 'string' ? p : '')), Number(p?.p) || undefined)
      if (!found) {
        dropped++
        continue
      }
      if (!passages.some((q) => q.unit === found.unit && q.text === found.text)) passages.push(found)
    }
    if (!passages.length) continue
    left[ti]--
    const opening = a.opening ? cleanOpening(item.opening, f) : ''
    posts.push({ id: `p${posts.length + 1}`, format: f.id, angle: cleanAngle(item.angle), ...(opening ? { hook: opening } : {}), passages })
  }
  return { posts: posts.slice(0, MAX_POSTS), dropped }
}

// ---- Creating the posts -------------------------------------------------------------------------

export interface CreateRequest {
  doc: string
  posts: PostRequest[]
}

export async function createPosts(input: CreateRequest, deps: BreakdownDeps = {}): Promise<CreateReply> {
  if (!input || typeof input !== 'object' || !Array.isArray(input.posts) || !input.posts.length) throw new HttpError(400, 'No posts to make')
  if (input.posts.length > MAX_POSTS) throw new HttpError(413, `At most ${MAX_POSTS} posts at once`)
  const piece = await readPiece(input.doc)
  const settings = await loadSettings()
  const a = allowance(deps.ceiling ?? settings.ceiling)
  if (a.plan === 'off') throw new HttpError(409, levelNote(a))
  const notes: string[] = []

  // 1. Check every post before anything is written: a known format, a kind it can file as, and at least one
  //    of the writer's passages found in the piece as it is now. A post with none is skipped, never made empty.
  const kindsNow = settings.kinds
  const toAdd = new Map<string, Kind>()
  let missing = 0
  let empty = 0
  const planned: { f: Format; kind: Kind; passages: string[]; angle: string; opening: string; adapt: boolean }[] = []
  for (const post of input.posts) {
    const f = findFormat(kindsNow, String(post?.format ?? ''))
    if (!f) throw new HttpError(400, 'Unknown kind of post')
    let kind = kindFor(f, kindsNow) ?? [...toAdd.values()].find((k) => f.kinds.includes(k.id))
    if (!kind) {
      const made = newKind(f.newKind ?? f.label, [...kindsNow, ...toAdd.values()])
      if (!made) throw new HttpError(409, `Can't add the kind “${f.newKind ?? f.label}”`)
      // Its typical length, from the platform's limit (about six characters a word), not a generic 800 words.
      made.words = f.measure === 'words' ? f.limit : Math.max(20, Math.round(f.limit / 6))
      toAdd.set(made.id, made)
      kind = made
    }
    const passages: string[] = []
    for (const q of Array.isArray(post.passages) ? post.passages.slice(0, 40) : []) {
      const found = typeof q === 'string' ? findPassage(piece.units, q.slice(0, 20_000)) : null
      if (found) passages.push(found.text)
      else missing++
    }
    if (!passages.length) {
      empty++
      continue
    }
    planned.push({ f, kind, passages, angle: cleanAngle(post.angle), opening: a.opening && post.useHook ? cleanOpening(post.hook, f) : '', adapt: Boolean(post.adapt) })
  }
  if (!planned.length) throw new HttpError(400, 'None of these posts has a passage from the piece. Add one to each post first.')

  // 2. The bodies, with any adaptations the ceiling allows. Model calls can be cancelled; nothing is written yet.
  let notAdapted = 0
  let strayed = 0
  let ask: Awaited<ReturnType<typeof model>> | undefined
  const bodies: { body: string; wording: string }[] = []
  for (const p of planned) {
    checkStop(deps)
    let body = quotedBody(p.f, p.passages, p.opening)
    let wording: string = p.opening ? WORDING.opening : WORDING.yours
    if (p.adapt) {
      if (a.adapt === 'none') notAdapted++
      else {
        if (ask === undefined) ask = await model(deps)
        let adapted: string | null = null
        try {
          adapted = ask ? await adapt(ask, p.f, p.kind, p.passages, p.angle, p.opening, a.adapt, deps, piece.title) : null
        } catch (e) {
          if (e instanceof Cancelled) throw e
        }
        // An adaptation that left the passages as they were is still the writer's own words, and says so.
        const same = (t: string) => t.replace(/\s+/g, ' ').trim()
        if (adapted && same(adapted) !== same(body)) {
          body = adapted
          wording = WORDING.adapted
        } else if (!adapted) strayed++
      }
    }
    bodies.push({ body, wording })
  }
  checkStop(deps)

  // 3. Add the kinds the posts need (settings read again just before, so a change made meanwhile is kept), then write.
  const addedKinds: string[] = []
  if (toAdd.size) {
    const fresh = (await loadSettings()).kinds
    const adding = [...toAdd.values()].filter((k) => !fresh.some((x) => x.id === k.id))
    if (adding.length) await saveSettings({ kinds: [...fresh, ...adding] })
    addedKinds.push(...adding.map((k) => k.name))
  }
  const paths = (await listFiles()).map((f) => f.path)
  const link = wikiLinkTo(paths, piece.rel)
  const counts = new Map<string, number>()
  const totals = new Map<string, number>()
  for (const p of planned) totals.set(p.f.id, (totals.get(p.f.id) ?? 0) + 1)
  const created: Created[] = []
  for (const [i, p] of planned.entries()) {
    const { body, wording } = bodies[i]
    const n = (counts.get(p.f.id) ?? 0) + 1
    counts.set(p.f.id, n)
    const title = `${piece.title} · ${p.f.label}${(totals.get(p.f.id) ?? 1) > 1 ? ` ${n}` : ''}`
    const meta: Record<string, string> = {
      title,
      platform: p.kind.id,
      status: 'draft',
      created: today(),
      // Namespaced: `from` is a property writers use for other things (an email's sender).
      'derived-from': link,
      ...(p.angle ? { angle: p.angle } : {}),
      ...(p.f.target ? { target: p.f.target } : {}),
      wording,
    }
    // A name already taken in the kind's folder gets -2, -3…: nothing is ever written over.
    const rel = await freePath(p.kind.folder, slugify(title))
    await writeDoc(rel, joinFrontMatter('', meta, body + '\n'), { reason: 'breakdown' })
    const fitNow = fit(p.f, body)
    created.push({ path: rel, title, format: p.f.id, wording, length: fitNow.length, limit: fitNow.limit, unit: unitName(p.f), over: fitNow.over })
  }
  if (addedKinds.length) notes.push(`Added the kind${addedKinds.length === 1 ? '' : 's'} ${addedKinds.map((k) => `“${k}”`).join(', ')}.`)
  if (missing) notes.push(`${missing} passage${missing === 1 ? ' isn’t' : 's aren’t'} in the piece any more, so ${missing === 1 ? 'it was' : 'they were'} left out.`)
  if (empty) notes.push(`${empty === 1 ? 'One post had' : `${empty} posts had`} no passage from the piece, so ${empty === 1 ? 'it wasn’t' : 'they weren’t'} made.`)
  if (notAdapted) notes.push(`Adapting the wording needs help ceiling 5, so ${notAdapted === 1 ? 'that post starts' : 'those posts start'} as your own words.`)
  if (strayed)
    notes.push(
      `${strayed === 1 ? 'One adaptation' : `${strayed} adaptations`} couldn’t keep to your words and the limit, so ${strayed === 1 ? 'that post starts' : 'those posts start'} as your own words.`,
    )
  const over = created.filter((c) => c.over).length
  if (over) notes.push(`${over} ${over === 1 ? 'draft is' : 'drafts are'} over the platform’s limit: trim as you write.`)
  return { created, notes, addedKinds }
}

/**
 * The writer's passages shaped into one post by the model, or null when the result doesn't hold up: over
 * the platform's limit, longer than the passages allow, or not their words in their order (adaptationProblems).
 * One retry. At help level 5 it cuts, reorders and joins their sentences; with whole drafts it may also write
 * an opening and a close in their voice, while the body stays theirs.
 */
async function adapt(
  ask: (system: string, prompt: string) => Promise<string>,
  f: Format,
  kind: Kind,
  passages: string[],
  angle: string,
  opening: string,
  scope: 'passages' | 'whole',
  deps: BreakdownDeps,
  title: string,
): Promise<string | null> {
  const unit = unitName(f)
  const source = passages.join('\n\n')
  const thread = f.shape === 'thread'
  const cap = thread ? `${f.parts} parts at most, each at most ${f.limit} ${unit}` : f.hard ? `at most ${f.limit.toLocaleString('en-US')} ${unit}` : `about ${f.limit} ${unit}`
  const voice = await voiceOf(deps, kind.id)
  const system = `You are Ekdanta, a writing collaborator built on restraint. The writer owns every word.
Shape the writer's passages (below) into one ${f.label}: ${cap}.
${
  scope === 'passages'
    ? 'Keep their sentences: cut, reorder and join them, and change only what the platform needs. Add no ideas, facts, examples or claims that are not in the passages, and nothing of your own beyond a few joining words.'
    : 'Keep their sentences for the body of the post. You may add a short opening and a short close of your own, in their voice, and the few words that join the passages, but add no facts, examples or claims that are not in the passages.'
}
Plain text, no hashtags or emoji unless the passages use them. Answer in the language of the passages.
Return JSON: ${thread ? '{"parts": ["...", "..."]}' : '{"text": "..."}'}`
  const prompt = `From the piece ${JSON.stringify(title)}.${angle ? `\nThe post's angle: ${angle}` : ''}${opening ? `\nStart with the writer's chosen opening line: ${JSON.stringify(opening)}` : ''}${voice}\n\nThe passages:\n"""\n${source}\n"""`
  let extra = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply: { text?: unknown; parts?: unknown }
    try {
      const raw = await ask(system, prompt + extra)
      reply = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
    } catch (e) {
      if (e instanceof Cancelled) throw e
      continue
    }
    const parts = thread ? (Array.isArray(reply.parts) ? reply.parts.map((p) => String(p).trim()).filter(Boolean) : []) : [String(reply.text ?? '').trim()].filter(Boolean)
    if (!parts.length) continue
    const all = parts.join('\n\n')
    const body = thread ? joinParts(parts) : asMarkdown(all)
    const fitNow = fit(f, body)
    // The opening the writer chose to keep is checked on its own (it was offered at level 4); the rest must be theirs.
    const problems = adaptationProblems(opening ? all.replace(opening, '') : all, passages, scope)
    if (fitNow.over) problems.unshift(`it went past the limit (${fitNow.length} ${unit}${thread ? ` in its longest part, ${fitNow.parts} parts` : ''})`)
    if (!problems.length) return body
    extra = `\n\nYour last answer was not usable: ${problems.join('; ')}. Try again, closer to the writer's words.`
  }
  return null
}

const today = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// ---- Routes -------------------------------------------------------------------------------------

/** Run a request that stops when the writer cancels (the page drops the request, closing its socket). */
async function stoppable<T>(req: IncomingMessage, run: (signal: AbortSignal) => Promise<T>): Promise<T | { kind: 'stopped' }> {
  const stop = stopSignal(req)
  try {
    return await run(stop.signal)
  } catch (e) {
    if (e instanceof Cancelled) return { kind: 'stopped' }
    throw e
  } finally {
    stop.dispose()
  }
}

export const breakdownRoutes: Record<string, Handler> = {
  'GET /api/breakdown/options': local(async (_req: IncomingMessage, url: URL) => breakdownOptions(url.searchParams.get('doc'))),
  'POST /api/breakdown/plan': local(async (req: IncomingMessage) => {
    const body = await readCapped<PlanRequest>(req, 64 * 1024)
    return stoppable(req, (signal) => planBreakdown(body, { signal }))
  }),
  'POST /api/breakdown/create': local(async (req: IncomingMessage) => {
    const body = await readCapped<CreateRequest>(req, 1_000_000)
    return stoppable(req, (signal) => createPosts(body, { signal }))
  }),
}
