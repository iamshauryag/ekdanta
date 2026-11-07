// The five help levels. Each one asks for exactly as much as its level allows,
// and checks the answer in code before it reaches the writer.
import { generate, parseJson, status, type Provider } from './ai.ts'
import { search } from './recall.ts'
import { voiceForPrompt } from './voice.ts'
import { settingsNow } from './settings.ts'
import { describeKind, findKind } from '../src/lib/kinds.ts'
import { capitalizeFirst, joinOnto, listItem, plainProse, repeatsFollowing, wholeSentences, wordEnding } from '../src/lib/prose.ts'
import { fenceBrief, withBrief } from '../src/lib/brief.ts'
import { briefForPrompt } from './brief.ts'

export interface HelpRequest {
  level: 1 | 2 | 3 | 4 | 5
  doc: string
  platform?: string
  /** The piece's title, as context for every level. */
  title?: string
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
  /** ⌥3 inside or right after a word: its letters before the cursor, and after it. */
  partial?: string
  suffix?: string
  /** ⌥3, ⌥4, ⌥5 at the start of a new paragraph or list item: never joined onto the line before. */
  atParagraphStart?: boolean
  /** …and that start is a new line after a line break, within the paragraph. */
  newLine?: boolean
  /** ⌥4, ⌥5 in a list: the next item. */
  list?: boolean
  /** ⌥4, ⌥5 on a heading: the heading whose section the new paragraph opens. */
  heading?: string
  /** ⌥4: rewrite the scope instead of continuing after it. */
  rewrite?: boolean
  /** ⌥5 with nothing selected at the end of a paragraph (or on an empty one): continue it. */
  continue?: boolean
  /** ⌥2 before the writer's first sentence: questions to start from, about the title. */
  opening?: boolean
  /** ⌥2 on an empty line after a paragraph: what the next paragraph could do. */
  nextParagraph?: boolean
  /** How many opening questions (a card holds 2–3; a Nudge is one). */
  count?: number
  /** Suggestions already shown, so cycling gives something new. */
  avoid?: string[]
}

/** What the piece is and how it should read, from its kind. */
const norms = (platform?: string) => describeKind(settingsNow().kinds, platform)

const RESTRAINT = `You are Ekdanta, a writing collaborator built on restraint. The writer owns every word.
Help only as much as you are asked, never more. Never add commentary, preambles, quotation marks around your answer, or explanations.`

/** The writer's voice profile for this platform, and a few of their own similar paragraphs (exemplars first). */
async function voiceSamples(req: HelpRequest) {
  const profile = await voiceForPrompt(req.platform)
  try {
    const hits = (await search(req.scope, { exclude: req.doc, limit: 8, sources: false }))
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

/** The title, beside the kind's guidance, so every level knows what the piece is about. */
const titleLine = (req: HelpRequest) => (req.title?.trim() ? `Title of the piece: ${JSON.stringify(req.title.trim().slice(0, 200))}\n\n` : '')

function context(req: HelpRequest) {
  return `${titleLine(req)}${req.before ? `Text before:\n"""${req.before.slice(-2500)}"""\n\n` : ''}${req.after ? `Text after:\n"""${req.after.slice(0, 1200)}"""\n\n` : ''}`
}

function avoidLine(req: HelpRequest) {
  return req.avoid?.length ? `\nDo not repeat any of these earlier suggestions: ${req.avoid.map((a) => JSON.stringify(a)).join(', ')}.` : ''
}

const avoiding = (req: HelpRequest) => new Set((req.avoid ?? []).map((a) => a.trim().toLowerCase()))

/** A word option as a model gives it, without stray dots, ellipses or trailing commas. */
const wordOption = (a: unknown) => clean(String(a)).replace(/^[\s.…]+|[\s,;:]+$/g, '')

export async function runHelp(req: HelpRequest): Promise<Record<string, unknown>> {
  if (req.level === 1) {
    const results = await search(req.scope, { exclude: req.doc, limit: 9 })
    return { kind: 'recall', results }
  }

  const s = await status()
  if (!s.strong || !s.fast) return { kind: 'error', message: 'No model available. Start Ollama, or sign in to the Claude CLI.' }
  const provider = req.level === 3 ? s.fast : s.strong
  try {
    return await generateHelp(req, s.strong, s.fast)
  } catch (e) {
    // Name the provider that failed, so the writer knows what to start or check.
    return { kind: 'error', message: (e as Error).message, provider }
  }
}

async function generateHelp(req: HelpRequest, strong: Provider, fast: Provider): Promise<Record<string, unknown>> {
  if (req.level === 2 && req.opening) {
    // Nothing written yet: questions to find a first line in, about the title and the kind. Never prose.
    const n = Math.max(1, Math.min(3, req.count ?? 1))
    // A pinned brief is what the piece answers, so the opening questions point at what it asks for.
    const brief = fenceBrief((await briefForPrompt(req.doc)) ?? '')
    const system = `${RESTRAINT}
Level 2, Nudge: the writer has not written their first line yet. Ask ${n === 1 ? 'ONE question' : `${n} different questions`} that would help them find it. Ask about the subject the title names (what they mean by it, a moment or example to start from, why it matters to them), suited to the kind of piece. Each at most 20 words.
Never write prose the writer could paste into the draft. Never praise. The piece is ${norms(req.platform)}. Return JSON: {"questions": ["..."]}${
      brief
        ? `\nThe writer has pinned what they are responding to (between <brief> tags in the request). Where it helps, ask about something it asks for, quoting a word or two of it. Ask in the language of the title, whatever language the brief is in.`
        : ''
    }`
    const prompt = `${brief}${titleLine(req)}${req.scope.trim() && req.scope.trim() !== req.title?.trim() ? `What the writer has typed so far:\n"""${req.scope.slice(0, 600)}"""\n` : ''}${avoidLine(req)}`
    const avoid = avoiding(req)
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = parseJson<{ questions?: unknown[] }>(await generate(strong, { system, prompt, json: true, temperature: 0.8 }))
      const qs = [...new Set((reply.questions ?? []).map((q) => clean(String(q))))].filter((q) => isNudge(q) && !avoid.has(q.toLowerCase())).slice(0, n)
      if (qs.length) return n === 1 ? { kind: 'nudge', text: qs[0], provider: strong } : { kind: 'questions', questions: qs, provider: strong }
    }
    return { kind: 'empty', message: 'No useful question here' }
  }

  if (req.level === 2) {
    const next = req.nextParagraph
    // A pinned brief (the question or email this piece answers) grounds the nudge; without one, nothing changes.
    const { system, prompt } = withBrief(
      {
        system: `${RESTRAINT}
Level 2, Nudge: reply with ONE question (or one short direction) that helps the writer think about ${
          next ? 'what their next paragraph could do, after the one they just finished' : 'the given paragraph'
        }. At most 20 words.
Never write prose the writer could paste into the draft. Never praise. The piece is ${norms(req.platform)}.`,
        prompt: `${context(req)}${next ? 'Paragraph the writer just finished (they are starting the next one)' : 'Paragraph the writer is working on'}:\n"""${req.scope}"""${avoidLine(req)}`,
      },
      await briefForPrompt(req.doc),
    )
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = clean(await generate(strong, { system, prompt, temperature: 0.8 }))
      if (isNudge(raw)) return { kind: 'nudge', text: raw, provider: strong }
    }
    return { kind: 'empty', message: 'No useful nudge here' }
  }

  if (req.level === 3 && req.next && req.partial) {
    // The caret is in a word, or right after one that may be unfinished: finish it.
    const partial = req.partial
    const inside = Boolean(req.suffix)
    const system = `${RESTRAINT}
Level 3, Word: the writer is typing a word and has typed "${partial}" so far${inside ? ` (the letters "${req.suffix}" follow the cursor, and may change)` : ''}. Suggest 4 or 5 single words that START WITH "${partial}" and fit the sentence's grammar, meaning and voice, best first.${
      inside ? '' : `\nIf "${partial}" is already a complete word that fits as it stands, set "complete" to true and instead suggest 4 or 5 options for the NEXT word.`
    }
The piece is ${norms(req.platform)}. Return JSON: {"complete": false, "alternatives": ["...", "..."]}`
    const prompt = `${titleLine(req)}Text before the cursor (it ends with the letters typed so far):\n"""${req.scope.slice(-1500)}"""${
      req.after?.trim() ? `\n\nText after the word:\n"""${req.after.slice(0, 300)}"""` : ''
    }${await voiceForPrompt(req.platform)}${avoidLine(req)}`
    const reply = parseJson<{ complete?: boolean; alternatives?: unknown[] }>(await generate(fast, { system, prompt, json: true, temperature: 0.6, tier: 'fast' }))
    const avoid = avoiding(req)
    const words = (reply.alternatives ?? []).map(wordOption)
    if (reply.complete === true && !inside) {
      const next = [...new Set(words)].filter((a) => /\w/.test(a) && !avoid.has(a.toLowerCase()) && a.split(/\s+/).length <= 2).slice(0, 5)
      if (next.length) return { kind: 'word', mode: 'next', alternatives: next, provider: fast }
    }
    // Only real completions, keeping the letters the writer typed exactly as typed.
    const done = [...new Set(words.filter((a) => !/\s/.test(a) && a.length > partial.length && a.toLowerCase().startsWith(partial.toLowerCase())).map((a) => partial + a.slice(partial.length)))]
      .filter((a) => !avoid.has(a.toLowerCase()) && a !== partial + (req.suffix ?? ''))
      .slice(0, 5)
    return done.length ? { kind: 'word', mode: 'complete', alternatives: done, provider: fast } : { kind: 'empty', message: 'No way to finish this word found' }
  }

  if (req.level === 3 && req.next) {
    const opener = req.atParagraphStart
    const system = `${RESTRAINT}
Level 3, Word: ${
      opener
        ? `the writer is starting a new ${req.newLine ? 'line' : 'paragraph'} after their text. Suggest 4 or 5 options for its FIRST word`
        : "suggest 4 or 5 options for the NEXT word at the writer's cursor"
    }. Each option is a SINGLE word that could come ${opener ? 'first' : 'immediately after the text'} and fits its grammar, meaning and voice (use a two-word phrase only when no single word can work). Best first; make them genuinely different from each other.
The piece is ${norms(req.platform)}. Return JSON: {"alternatives": ["...", "..."]}`
    const prompt = `${titleLine(req)}${opener ? "The writer's text so far" : 'Text before the cursor'}:\n"""${req.scope.slice(-1500)}"""${
      req.after?.trim() ? `\n\n${opener ? 'The paragraph after the new one' : 'Text after the cursor (the next word must lead into it)'}:\n"""${req.after.trim().slice(0, 300)}"""` : ''
    }${await voiceForPrompt(req.platform)}${avoidLine(req)}`
    const raw = await generate(fast, { system, prompt, json: true, temperature: 0.7, tier: 'fast' })
    const avoid = avoiding(req)
    const alts = [...new Set(parseJson<{ alternatives: unknown[] }>(raw).alternatives.map((a) => (opener ? capitalizeFirst(wordOption(a)) : wordOption(a))))]
      .filter((a) => /\w/.test(a) && !avoid.has(a.toLowerCase()) && a.split(/\s+/).length <= 2)
      .slice(0, 5)
    return alts.length ? { kind: 'word', alternatives: alts, provider: fast } : { kind: 'empty', message: opener ? 'No opening word found' : 'No next word found' }
  }

  if (req.level === 3) {
    const system = `${RESTRAINT}
Level 3, Word: suggest 4 or 5 replacements for the target word or phrase that fit the sentence's grammar and meaning, best first.
The piece is ${norms(req.platform)}. Return JSON: {"alternatives": ["...", "..."]}`
    const prompt = `${titleLine(req)}Sentence: ${req.sentence ?? req.scope}\nTarget: ${req.scope}${await voiceForPrompt(req.platform)}${avoidLine(req)}`
    const raw = await generate(fast, { system, prompt, json: true, temperature: 0.6, tier: 'fast' })
    const target = req.scope.trim().toLowerCase()
    const avoid = avoiding(req)
    const alts = [...new Set(parseJson<{ alternatives: string[] }>(raw).alternatives.map((a) => clean(a)))]
      .filter((a) => a && a.toLowerCase() !== target && !avoid.has(a.toLowerCase()) && a.split(/\s+/).length <= 4)
      .slice(0, 5)
    return alts.length ? { kind: 'word', alternatives: alts, provider: fast } : { kind: 'empty', message: 'No better word found' }
  }

  if ((req.level === 4 && !req.rewrite) || (req.level === 5 && req.continue)) return continuation(req, strong)

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

/**
 * ⌥4 (one sentence) and ⌥5 with nothing selected (2–4 sentences) at the caret: on the writer's line,
 * as a new paragraph, as the opening of the section under a heading, or as the next list item.
 * The reply is checked in code: plain prose, whole sentences, within the budget, not an echo.
 */
async function continuation(req: HelpRequest, strong: Provider): Promise<Record<string, unknown>> {
  const many = req.level === 5
  const budget = Math.max(20, Math.min(90, findKind(settingsNow().kinds, req.platform ?? 'essay')?.words ?? 90))
  const fresh = Boolean(req.atParagraphStart || req.list || req.heading !== undefined)
  const length = many ? `2 to 4 sentences, at most ${budget} words in all` : 'ONE sentence, and only that'
  const what = req.list
    ? 'Write the NEXT item of the list the writer is making: one item, in the same form and length as their items (a phrase or a sentence, as theirs are). No list marker.'
    : req.heading !== undefined
      ? `Write the opening of the section under the heading ${JSON.stringify(req.heading)}, as a new paragraph: ${length}.`
      : req.atParagraphStart
        ? `The writer has started a new ${req.newLine ? 'line (after a line break, in the same paragraph)' : 'paragraph'} after their text. Write its opening: ${length}.`
        : many
          ? `Continue the writer's paragraph from exactly where it stops: ${length}, finishing the current sentence first if it is unfinished. Stay within this paragraph's thought.`
          : "Continue the writer's text from exactly where it stops. Write AT MOST one sentence: finish the current sentence if it is unfinished, otherwise write the single next sentence."
  // Text that stops right after letters may stop mid-word ("…keep writ"): the model says which letters finish
  // the word, apart from the rest, so the rest can be joined with exactly one space.
  const midWord = !fresh && req.partial ? req.partial : ''
  const system = `${RESTRAINT}
Level ${req.level}, ${many ? 'Passage' : 'Sentence'}: ${what}
Plain prose only: no headings, no lists, no line breaks. Match the writer's voice, rhythm and diction. The piece is ${norms(req.platform)}. ${
    midWord
      ? `The text ends with "${midWord}", which may be an unfinished word. Return JSON: {"finish": "...", "text": "..."}, where "finish" is only the letters that complete that word (empty if it is already a whole word) and "text" is everything after the word, starting with any punctuation that follows it.`
      : 'Output only the new text.'
  }`
  const where = fresh ? "The writer's text so far (the new text comes after it)" : "The writer's text ends here (continue from the very last character)"
  const prompt = `${context({ ...req, after: undefined })}${where}:\n"""${req.scope}"""${
    req.after?.trim() ? `\n\nWhat already follows (lead into it; do not repeat it):\n"""${req.after.trim().slice(0, 600)}"""` : ''
  }${await voiceSamples(req)}${avoidLine(req)}`
  const avoid = avoiding(req)
  let text = ''
  // Models sometimes echo the text that already follows the caret; that's not a continuation. One retry.
  let finish = ''
  for (let attempt = 0; attempt < 2 && !text; attempt++) {
    const raw = await generate(strong, { system, prompt, temperature: 0.8, json: Boolean(midWord) })
    let reply = raw
    if (midWord) {
      const parts = parseJson<{ finish?: unknown; text?: unknown }>(raw)
      const [letters, stop] = wordEnding(String(parts.finish ?? ''))
      finish = letters
      const rest = String(parts.text ?? '')
      reply = stop && !/^\s*[.,;:!?…]/.test(rest) ? stop + (/^\s/.test(rest) ? '' : ' ') + rest : rest
    }
    const prose = plainProse(clean(reply))
    const candidate = req.list
      ? listItem(prose, 40)
      : many
        ? wholeSentences(prose, budget, 4)
        : // One sentence; on the writer's line an unfinished clause is fine (it may finish theirs).
          wholeSentences(prose, 60, 1) || (fresh ? '' : prose.split(/\s+/).slice(0, 30).join(' '))
    if (candidate.trim() && !repeatsFollowing(candidate, req.after) && !avoid.has(candidate.trim().toLowerCase())) text = candidate
  }
  if (!text.trim()) return { kind: 'empty', message: many ? 'No suggestion' : 'No continuation found' }
  // On the writer's line: exactly one space before it. A new paragraph, section or item: a capital, no space.
  return { kind: 'ghost', text: finish + joinOnto(req.scope + finish, text, fresh), provider: strong }
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
