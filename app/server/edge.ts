// Edge lines: a subject, title, excerpt or opening line, drawn from the writer's own sentences.
// The model proposes; the code guards in src/lib/edge.ts decide what the writer sees.
import { describeKind } from '../src/lib/kinds.ts'
import { vaultKinds } from './kinds.ts'
import { EDGE_LIMITS, MIN_SENTENCES, NOTHING_FITS, NO_MORE, TOO_SHORT, guardCandidates, sentencesOf, type EdgeCandidate, type EdgeSlot } from '../src/lib/edge.ts'

export interface EdgeRequest {
  slot: EdgeSlot
  /** The draft's plain text. */
  text: string
  kind?: string
  /** What the field says now, so it isn't offered back. */
  current?: string
  /** Candidates already shown, so asking again gives new ones. */
  avoid?: string[]
}

export type EdgeResponse = { kind: 'edge'; candidates: EdgeCandidate[]; provider: string } | { kind: 'empty'; message: string } | { kind: 'error'; message: string }

const SLOTS: EdgeSlot[] = ['title', 'opening', 'subject', 'excerpt']

const WHAT: Record<EdgeSlot, string> = {
  subject: 'an email subject line',
  title: 'a title',
  excerpt: 'a one- or two-sentence excerpt (the summary shown under a blog post’s title)',
  opening: 'an opening line (the first line people see before "see more")',
}

const RESTRAINT = `You are Ekdanta, a writing collaborator built on restraint. The writer owns every word.`

/** A stand-in model for tests and offline checks: lines cut from the draft, plus one that invents a number. */
export function fakeCandidates(text: string): EdgeCandidate[] {
  const s = sentencesOf(text)
  const cut = (x: string, n: number) =>
    x
      .split(/\s+/)
      .slice(0, n)
      .join(' ')
      .replace(/[,;:]$/, '')
  return [{ text: 'We raised $5M on the back of this', source: s[0] }, ...s.slice(0, 6).map((x, i) => ({ text: i % 2 ? cut(x, 7) : x.replace(/[.!]$/, ''), source: x }))]
}

export async function runEdge(req: EdgeRequest): Promise<EdgeResponse> {
  const kinds = await vaultKinds()
  const slot = SLOTS.includes(req.slot) ? req.slot : 'title'
  const text = String(req.text ?? '').slice(0, 12000)
  if (sentencesOf(text).length < MIN_SENTENCES) return { kind: 'empty', message: TOO_SHORT }
  const opts = { avoid: req.avoid, current: req.current }
  // Nothing new after lines were already shown means the draft is used up, not that nothing fits.
  const none = (): EdgeResponse => ({ kind: 'empty', message: req.avoid?.length ? NO_MORE : NOTHING_FITS })

  if (process.env.EKDANTA_FAKE_MODEL) {
    const candidates = guardCandidates(fakeCandidates(text), text, slot, opts)
    return candidates.length ? { kind: 'edge', candidates, provider: 'fake' } : none()
  }

  // Loaded only when a real model answers (ai.ts pulls in the Claude session pool).
  const { generate, parseJson, status } = await import('./ai.ts')
  const s = await status()
  if (!s.strong) return { kind: 'error', message: 'No model available. Start Ollama, or sign in to the Claude CLI.' }
  const system = `${RESTRAINT}
Propose 5 candidates for ${WHAT[slot]} for the writer's draft, at most ${EDGE_LIMITS[slot]} characters each.
Draw every candidate from ONE sentence of the draft: lift it, shorten it, or lightly reword it, keeping the writer's own words and voice.
Never add a fact, number, name, product or claim that is not in the draft. No clickbait, no hype words, no emoji, no hashtags.
The piece is ${describeKind(kinds, req.kind)}.
Return JSON: {"candidates": [{"text": "...", "source": "the exact sentence from the draft, copied character for character"}]}`
  let candidates: EdgeCandidate[] = []
  const avoid = [...(req.avoid ?? [])]
  // One more try when the guards leave too few to choose from.
  for (let attempt = 0; attempt < 2 && candidates.length < 3; attempt++) {
    const prompt = `Draft:\n"""${text}"""${req.current ? `\n\nThe ${slot} it has now (offer something different): ${JSON.stringify(req.current)}` : ''}${
      avoid.length ? `\n\nDo not repeat any of these: ${avoid.map((a) => JSON.stringify(a)).join(', ')}.` : ''
    }`
    let raw: unknown = []
    try {
      raw = parseJson<{ candidates: unknown }>(await generate(s.strong, { system, prompt, json: true, temperature: 0.7 })).candidates
    } catch (e) {
      if (attempt === 0 && !candidates.length && !/No JSON/.test((e as Error).message)) throw e
    }
    const more = guardCandidates(raw, text, slot, { ...opts, avoid: [...avoid, ...candidates.map((c) => c.text)] })
    candidates = [...candidates, ...more].slice(0, 5)
    avoid.push(...more.map((c) => c.text))
  }
  return candidates.length ? { kind: 'edge', candidates, provider: s.strong } : none()
}
