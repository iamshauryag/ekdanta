// The five help levels. Each one asks for exactly as much as its level allows,
// and checks the answer in code before it reaches the writer.
import { generate, parseJson, status } from './ai.ts'
import { search } from './recall.ts'
import { voiceForPrompt } from './voice.ts'

export interface HelpRequest {
  level: 1 | 2 | 3 | 4 | 5
  doc: string
  platform?: string
  /** The text the help applies to: a paragraph, a selection, or a word. */
  scope: string
  /** Text before and after the scope (a few paragraphs each way). */
  before?: string
  after?: string
  /** ⌥3: the sentence containing the word. */
  sentence?: string
  /** ⌥5 (and ⌥4 rewrite): what the writer asked for. */
  instruction?: string
  /** ⌥3 with nothing selected: suggest the next word at the cursor instead of replacing one. */
  next?: boolean
  /** ⌥4: rewrite the scope instead of continuing after it. */
  rewrite?: boolean
  /** Suggestions already shown, so cycling gives something new. */
  avoid?: string[]
}

const PLATFORM_NORMS: Record<string, string> = {
  essay: 'a personal essay: considered, concrete, unhurried',
  linkedin: 'a LinkedIn post: short paragraphs, a strong first line, plain words, no hashtags or emoji unless the writer uses them',
  email: 'an email: clear, courteous, gets to the point',
  text: 'a text message: brief and natural',
  blog: 'a blog post: conversational but substantial',
}

function norms(platform?: string) {
  return PLATFORM_NORMS[(platform ?? 'essay').toLowerCase()] ?? PLATFORM_NORMS.essay
}

const RESTRAINT = `You are Ekdanta, a writing collaborator built on restraint. The writer owns every word.
Help only as much as you are asked, never more. Never add commentary, preambles, quotation marks around your answer, or explanations.`

/** The writer's voice profile for this platform, and a few of their own similar paragraphs (exemplars first). */
async function voiceSamples(req: HelpRequest) {
  const profile = await voiceForPrompt(req.platform)
  try {
    const hits = (await search(req.scope, { exclude: req.doc, limit: 8 }))
      .map((h) => ({ ...h, rank: h.score + (h.exemplar ? 0.05 : 0) }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 3)
    if (!hits.length) return profile
    return `${profile}\n\nFor reference only, passages the writer wrote elsewhere (match their voice, rhythm and diction; do not reuse their content):\n${hits
      .map((h) => `---\n${h.text}`)
      .join('\n')}\n---`
  } catch {
    return profile
  }
}

function context(req: HelpRequest) {
  return `${req.before ? `Text before:\n"""${req.before.slice(-2500)}"""\n\n` : ''}${req.after ? `Text after:\n"""${req.after.slice(0, 1200)}"""\n\n` : ''}`
}

function avoidLine(req: HelpRequest) {
  return req.avoid?.length ? `\nDo not repeat any of these earlier suggestions: ${req.avoid.map((a) => JSON.stringify(a)).join(', ')}.` : ''
}

export async function runHelp(req: HelpRequest): Promise<Record<string, unknown>> {
  if (req.level === 1) {
    const results = await search(req.scope, { exclude: req.doc, limit: 9 })
    return { kind: 'recall', results }
  }

  const s = await status()
  const strong = s.strong
  const fast = s.fast
  if (!strong || !fast) return { kind: 'error', message: 'No model available. Start Ollama, or sign in to the Claude CLI.' }

  if (req.level === 2) {
    const system = `${RESTRAINT}
Level 2, Nudge: reply with ONE question (or one short direction) that helps the writer think about the given paragraph. At most 20 words.
Never write prose the writer could paste into the draft. Never praise. The piece is ${norms(req.platform)}.`
    const prompt = `${context(req)}Paragraph the writer is working on:\n"""${req.scope}"""${avoidLine(req)}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = clean(await generate(strong, { system, prompt, temperature: 0.8 }))
      if (isNudge(raw)) return { kind: 'nudge', text: raw, provider: strong }
    }
    return { kind: 'empty', message: 'No useful nudge here' }
  }

  if (req.level === 3 && req.next) {
    const system = `${RESTRAINT}
Level 3, Word: suggest 4 or 5 options for the NEXT word at the writer's cursor. Each option is a SINGLE word that could come immediately after the text and fits its grammar, meaning and voice (use a two-word phrase only when no single word can work). Best first; make them genuinely different from each other.
The piece is ${norms(req.platform)}. Return JSON: {"alternatives": ["...", "..."]}`
    const prompt = `Text before the cursor:\n"""${req.scope.slice(-1500)}"""${
      req.after?.trim() ? `\n\nText after the cursor (the next word must lead into it):\n"""${req.after.slice(0, 300)}"""` : ''
    }${await voiceForPrompt(req.platform)}${avoidLine(req)}`
    const raw = await generate(fast, { system, prompt, json: true, temperature: 0.7, tier: 'fast' })
    const avoid = new Set((req.avoid ?? []).map((a) => a.toLowerCase()))
    const alts = [...new Set(parseJson<{ alternatives: string[] }>(raw).alternatives.map((a) => clean(a).replace(/^[\s.…]+/, '')))]
      .filter((a) => /\w/.test(a) && !avoid.has(a.toLowerCase()) && a.split(/\s+/).length <= 2)
      .slice(0, 5)
    return alts.length ? { kind: 'word', alternatives: alts, provider: fast } : { kind: 'empty', message: 'No next word found' }
  }

  if (req.level === 3) {
    const system = `${RESTRAINT}
Level 3, Word: suggest 4 or 5 replacements for the target word or phrase that fit the sentence's grammar and meaning, best first.
The piece is ${norms(req.platform)}. Return JSON: {"alternatives": ["...", "..."]}`
    const prompt = `Sentence: ${req.sentence ?? req.scope}\nTarget: ${req.scope}${await voiceForPrompt(req.platform)}${avoidLine(req)}`
    const raw = await generate(fast, { system, prompt, json: true, temperature: 0.6, tier: 'fast' })
    const target = req.scope.trim().toLowerCase()
    const avoid = new Set((req.avoid ?? []).map((a) => a.toLowerCase()))
    const alts = [...new Set(parseJson<{ alternatives: string[] }>(raw).alternatives.map((a) => clean(a)))]
      .filter((a) => a && a.toLowerCase() !== target && !avoid.has(a.toLowerCase()) && a.split(/\s+/).length <= 4)
      .slice(0, 5)
    return alts.length ? { kind: 'word', alternatives: alts, provider: fast } : { kind: 'empty', message: 'No better word found' }
  }

  if (req.level === 4 && !req.rewrite) {
    const system = `${RESTRAINT}
Level 4, Sentence: continue the writer's text from exactly where it stops. Write AT MOST one sentence: finish the current sentence if it is unfinished, otherwise write the single next sentence.
Match the writer's voice. The piece is ${norms(req.platform)}. Output only the continuation text.`
    const prompt = `${context({ ...req, after: undefined })}The writer's text ends here (continue from the very last character):\n"""${req.scope}"""${
      req.after ? `\n\nWhat follows the cursor (do not repeat it):\n"""${req.after.slice(0, 600)}"""` : ''
    }${await voiceSamples(req)}${avoidLine(req)}`
    let text = ''
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      const candidate = firstSentence(clean(await generate(strong, { system, prompt, temperature: 0.8 }), { keepLeadingSpace: true }))
      // Models sometimes echo the text that already follows the cursor; that's not a continuation.
      if (candidate.trim() && !repeatsFollowing(candidate, req.after)) text = candidate
    }
    if (!text.trim()) return { kind: 'empty', message: 'No continuation found' }
    // Join cleanly onto what's already there.
    // A continuation stays on the writer's line: never a stray line break, exactly one space.
    text = text.replace(/\n+/g, ' ').trimStart()
    if (!/\s$/.test(req.scope) && !/^[,.;:!?)'’"]/.test(text)) text = ' ' + text
    return { kind: 'ghost', text, provider: strong }
  }

  // Level 5 (and ⌥4 rewriting a selected sentence): rewrite only the scope.
  const one = req.level === 4
  const system = `${RESTRAINT}
Level ${req.level}, ${one ? 'Sentence' : 'Passage'}: rewrite ONLY the given ${one ? 'sentence' : 'passage'} according to the writer's instruction.
Change as little as needed to satisfy the instruction; keep everything that already works, keep the writer's voice, and keep Markdown formatting.
Do not add new ideas the writer didn't have. The piece is ${norms(req.platform)}. Output only the rewritten text.`
  const prompt = `${context(req)}Instruction: ${req.instruction || (one ? 'Make this sentence better, in my voice.' : 'Improve this passage, in my voice.')}\n\n${
    one ? 'Sentence' : 'Passage'
  } to rewrite:\n"""${req.scope}"""${await voiceSamples(req)}${avoidLine(req)}`
  const text = clean(await generate(strong, { system, prompt, temperature: 0.6 }))
  if (!text || text === req.scope.trim()) return { kind: 'empty', message: 'No change suggested' }
  return { kind: 'rewrite', text, provider: strong }
}

/** Strip wrappers models add despite instructions: quotes, fences, labels. */
function clean(text: string, opts: { keepLeadingSpace?: boolean } = {}) {
  let t = text.replace(/^```[\w-]*\n?|\n?```$/g, '')
  t = opts.keepLeadingSpace ? t.replace(/\s+$/, '') : t.trim()
  t = t.replace(/^(Here(?:'s| is)[^:\n]*:|Rewritten[^:\n]*:|Continuation:)\s*/i, '')
  const lead = t.match(/^\s*/)?.[0] ?? ''
  const core = t.slice(lead.length)
  const unquoted = core.replace(/^"""|"""$/g, '').replace(/^["“](.*)["”]$/s, '$1')
  return lead + unquoted
}

/** A nudge is a short question or direction, never draft prose. */
function isNudge(t: string) {
  const words = t.split(/\s+/).filter(Boolean).length
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean).length
  return words > 0 && words <= 24 && sentences <= 2 && (/\?\s*$/.test(t) || /^(try|consider|what|which|how|why|where|who|show|name|cut|add|start|end)\b/i.test(t))
}

function repeatsFollowing(text: string, after?: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const t = norm(text)
  const a = norm(after ?? '')
  return t.length > 0 && a.length > 0 && (a.startsWith(t) || a.startsWith(t.split(' ').slice(0, 4).join(' ')))
}

function firstSentence(t: string) {
  const m = t.match(/^[\s\S]*?[.!?…](?:["'”’)\]]*)(?=\s|$)/)
  return m ? m[0] : t
}
