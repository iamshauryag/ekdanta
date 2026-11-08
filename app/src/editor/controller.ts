// Turns a help keystroke into a request, and the response into a suggestion on the page.
//
// With nothing selected, what each level does depends on where the caret is (planCaret in caret.ts).
// Restraint: ⌘3–⌘5 write text only once the body has a sentence of the writer's own; before that
// they offer questions. Nothing goes into the page until the writer presses a key to accept it.
//
// | Caret                         | ⌘1 Recall           | ⌘2 Nudge              | ⌘3 Word                 | ⌘4 Sentence              | ⌘5 Passage                     |
// |-------------------------------|---------------------|-----------------------|-------------------------|--------------------------|--------------------------------|
// | End of a paragraph            | on the paragraph    | on the paragraph      | next word               | one-sentence ghost       | 2–4 sentence ghost (continue)  |
// | Mid-paragraph, between words  | on the paragraph    | on the paragraph      | next word               | one-sentence ghost       | rewrite bar, with a hint       |
// | In or after a word ("writ|")  | on the paragraph    | on the paragraph      | finish the word         | ghost after the word     | rewrite bar (mid-paragraph)    |
// | After a short word ("the|")   | on the paragraph    | on the paragraph      | next word               | one-sentence ghost       | as its position says           |
// | Empty line after text         | the paragraph above | what comes next       | capitalised openers     | opening sentence         | opening 2–4 sentences          |
// | Heading                       | on the heading      | on the heading        | next word               | section's first sentence | section's first 2–4 sentences  |
// | List item                     | on the item         | on the item           | next word / finish it   | the next item            | the next item                  |
// | Code block, table             | Help is off inside code (or tables)                                                                                     |
// | Body has no sentence, title   | on the title        | an opening question   | a card of 2–3 opening questions, never prose                                  |
// | Body has no sentence, no title| Write a line first, or open Thinking Space                                                                              |
//
// A ghost from ⌘5 takes Tab for the next sentence, ⌥→ for a word, ⌘↵ for all of it, ⌘5 for another,
// Esc or ⌘0 to dismiss. A selection works as it always has: ⌘3 replaces, ⌘4 and ⌘5 rewrite.
import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { binding, formatKey } from '../lib/keys.ts'
import { firstWord, hasOwnSentence, isCompleteWord, sentences, splitFirstSentence, wordAtCaret } from '../lib/prose.ts'
import { SERVER_DOWN, friendlyError, planCaret, type Block, type Caret, type Place } from './caret.ts'
import {
  blockEnd,
  changedRatio,
  computeHunks,
  dotOf,
  edgeLabel,
  helpKey,
  helpMod,
  helpOf,
  paragraphAt,
  sentenceAround,
  setHelp,
  setWidgetHooks,
  textMap,
  textOf,
  type Help,
  type HelpMeta,
  type Level,
  type PageProposal,
  type RecallResult,
} from './help.ts'
import { EDGE_NAMES, openingEdit, sentencesOf, titleHelp, type EdgeCandidate, type EdgeSlot } from '../lib/edge.ts'
import { isPromptParagraph } from '../lib/special.ts'
import { sentenceCount } from '../lib/versions.ts'
import { AFTER_STOP, splitAfter } from '../lib/split.ts'

export interface HistoryItem {
  level: Level
  at: string
  from: number
  outcome: 'accepted' | 'rejected' | 'partly accepted' | 'dismissed' | 'resolved' | 'inserted' | 'shown' | 'empty' | 'error'
  detail?: string
  instruction?: string
  sources?: { doc: string; title: string; folder: string }[]
}

export interface ControllerOptions {
  doc: () => string
  platform: () => string
  title: () => string
  /** The model provider in use, to name it when it can't be reached. */
  provider: () => string | null
  ceiling: () => number
  record: (item: HistoryItem) => void
  /** Keep a version of the text as it is now (called just before help replaces more than a sentence). */
  snapshot?: (reason: string) => void
  openDoc: (path: string) => void
  /** What a title, subject or excerpt says now, so edge lines don't offer it back. */
  edgeCurrent?: (slot: EdgeSlot) => string
  /** Use an accepted title, subject or excerpt (an opening line is proposed on the page instead). */
  acceptEdge?: (slot: EdgeSlot, text: string) => void
}

type Resp =
  | { kind: 'recall'; results: RecallResult[] }
  | { kind: 'nudge'; text: string }
  | { kind: 'word'; alternatives: string[]; mode?: 'next' | 'complete' }
  | { kind: 'ghost'; text: string }
  | { kind: 'questions'; questions: string[] }
  | { kind: 'rewrite'; text: string }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string; provider?: string }

type EdgeResp = { kind: 'edge'; candidates: EdgeCandidate[] } | { kind: 'empty'; message: string } | { kind: 'error'; message: string; error?: string }

const EMPTY_MESSAGES: Record<Level, string> = {
  1: 'Nothing in your vault on this yet',
  2: 'No useful nudge here',
  3: 'No better word found',
  4: 'No continuation found',
  5: 'No change suggested',
}

/**
 * Insert plain text at a position, inheriting the formatting there: a blank line starts a new
 * paragraph and a single newline is a line break, as the model's own text would read.
 */
function insertPlain(tr: Transaction, from: number, to: number, text: string) {
  const schema = tr.doc.type.schema
  // Replaced text keeps its own formatting. New text between two runs gets only what both share,
  // so a word added after bold text isn't bold unless the text after it is too.
  const $from = tr.doc.resolve(from)
  const marks = to > from ? (tr.doc.resolve(from + 1).marks() ?? []) : $from.marks().filter((m) => (tr.doc.resolve(Math.min(to, tr.doc.content.size)).nodeAfter?.marks ?? []).some((n) => n.eq(m)))
  if (to > from) tr.delete(from, to)
  let pos = from
  text.split(/\n{2,}/).forEach((para, i) => {
    if (i > 0) {
      tr.split(pos)
      pos += 2
    }
    para.split('\n').forEach((line, j) => {
      if (j > 0) {
        tr.insert(pos, schema.nodes.hardBreak.create())
        pos += 1
      }
      if (line) {
        tr.insert(pos, schema.text(line, marks))
        pos += line.length
      }
    })
  })
  return pos
}

export class HelpController {
  private seq = 0
  private ceilingPrompt: { level: Level; at: number } | null = null
  private allowOnce: Level | null = null
  private slowTimer: number | undefined
  private dotTimer: number | undefined
  private dotPara = -1
  /** Told how the latest change proposed from the Assistant tab was decided. */
  private onProposal: PageProposal['onDone'] | undefined

  constructor(
    private view: EditorView,
    private opts: ControllerOptions,
  ) {
    setWidgetHooks({
      runInstruction: (t) => this.runInstruction(t),
      dismiss: () => this.dismiss(),
      pickWord: (i) => this.pickWord(i),
      pickEdge: (i) => this.pickEdge(i),
      moreEdge: () => {
        const h = this.help
        if (h?.kind === 'edge' && !h.note) this.fetchEdge(h.slot, [...h.seen, ...h.options.map((o) => o.text)])
      },
      insertRecall: (i) => this.insertRecall(i),
      openSource: (doc) => this.opts.openDoc(doc),
      resolveNudge: () => this.resolveNudge(),
      decideHunk: (i, s) => this.decideHunk(i, s),
      acceptAll: () => this.finishDiff('accepted'),
      rejectAll: () => this.finishDiff('rejected'),
      stepHunk: (d) => this.stepHunk(d),
      focusEditor: () => this.view.focus(),
      current: () => this.help,
      propose: (p) => this.propose(p),
      recallAtDot: () => {
        const pos = dotOf(this.view.state)
        if (pos !== null) this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos)))
        this.request(1)
      },
    })
  }

  get help(): Help | null {
    return helpOf(this.view.state)
  }

  private get doc(): PMNode {
    return this.view.state.doc
  }

  private set(help: Help | null) {
    window.clearTimeout(this.slowTimer)
    this.view.dispatch(setHelp(this.view.state.tr, help))
    if (help && 'at' in help && help.at === 0) this.resyncCaret()
  }

  /**
   * A card drawn at the very top of the page sits right before the caret when it's at the start of
   * the text. Chrome keeps a stale caret after an uneditable block is drawn next to it and silently
   * drops typing there, so set the same caret again once the card is on the page.
   */
  private resyncCaret() {
    if (!this.view.hasFocus()) return
    const sel = this.view.dom.ownerDocument.getSelection()
    if (!sel || !sel.rangeCount || !this.view.dom.contains(sel.anchorNode)) return
    const range = sel.getRangeAt(0).cloneRange()
    sel.removeAllRanges()
    sel.addRange(range)
  }

  private record(item: Omit<HistoryItem, 'at'>) {
    this.opts.record({ ...item, at: new Date().toISOString() })
  }

  dismiss() {
    const h = this.help
    if (!h) return
    this.seq++
    if (h.kind === 'diff') return this.finishDiff('rejected')
    this.noteDismissed(h)
    this.set(null)
  }

  /** A suggestion went away without being used (Esc, or typing over it): note it in the history. */
  noteDismissed(h: Help) {
    if (h.kind === 'ghost' && h.taken.trim()) return this.recordGhost(h, 'partly accepted')
    if (['recall', 'nudge', 'word', 'ghost', 'questions', 'edge'].includes(h.kind)) {
      this.record({ level: (h as { level: Level }).level, from: h.from, outcome: 'dismissed' })
    }
  }

  private recordGhost(h: Extract<Help, { kind: 'ghost' }>, outcome: 'accepted' | 'partly accepted') {
    const n = sentences(h.taken).length
    const what = h.block === 'listItem' || h.block === 'taskItem' ? 'next list item' : h.level === 5 ? `continued paragraph · ${n} sentence${n === 1 ? '' : 's'}` : h.taken.trim()
    this.record({ level: h.level, from: h.from, outcome, detail: what })
  }

  // ---- Asking -------------------------------------------------------------------------------

  request(level: Level) {
    const { state } = this.view
    const sel = state.selection
    const current = this.help

    // The ceiling never silently downgrades or exceeds: it asks.
    if (level > this.opts.ceiling() && this.allowOnce !== level) {
      const p = this.ceilingPrompt
      if (p && p.level === level && Date.now() - p.at < 3000) {
        this.allowOnce = level
        this.ceilingPrompt = null
      } else {
        this.ceilingPrompt = { level, at: Date.now() }
        const para = paragraphAt(state, sel.head)
        const text = this.opts.ceiling() === 0 ? 'Help is off · change the ceiling in the Piece panel' : `Ceiling is ${this.opts.ceiling()} · press ${helpMod}${level} again to allow once`
        this.set({ kind: 'notice', from: para.from, to: para.to, at: para.after, text })
        return
      }
    }

    // Same key again = next suggestion: more Recall results, or something not shown yet.
    let avoid: string[] = []
    if (current && 'level' in current && current.level === level && current.kind !== 'loading') {
      if (current.kind === 'recall' && current.results.length > (current.page + 1) * 3) {
        this.set({ ...current, page: current.page + 1, sel: (current.page + 1) * 3 })
        return
      }
      // ⌘3 again asks for more titles or opening lines; a subject or excerpt card leaves ⌘3 in the text as it was.
      // Once the draft is used up the card stays as it is, saying so.
      if (current.kind === 'edge' && (current.slot === 'title' || current.slot === 'opening'))
        return current.note ? undefined : this.fetchEdge(current.slot, [...current.seen, ...current.options.map((o) => o.text)])
      if (current.kind === 'word') avoid = [...current.seen, ...current.options]
      else if (current.kind === 'ghost') avoid = [...current.seen, current.text.trim()]
      else if (current.kind === 'nudge') avoid = current.history
      else if (current.kind === 'questions') avoid = [...current.seen, ...current.questions]
    }

    if (sel.empty) return this.atCaret(level, avoid)
    if (this.inBlock(sel.from, 'codeBlock') || this.inBlock(sel.to, 'codeBlock')) return this.notice(level, sel.to, NOTICES.code())

    const para = paragraphAt(state, sel.head)
    if (level === 1) return this.fetchRecall(sel.from, sel.to)
    if (level === 2) return this.fetchNudge(sel.from, sel.to, avoid)
    if (level === 3) {
      // A selection: what could replace it?
      const text = textOf(this.doc, sel.from, sel.to)
      if (text.split(/\s+/).filter(Boolean).length > 4 || text.includes('\n')) {
        return this.notice(3, sel.to, `${helpMod}3 works on a word or short phrase`)
      }
      if (current?.kind === 'word' && current.mode === 'replace' && current.from === sel.from && current.to === sel.to) return this.fetchWord(sel.from, sel.to, current.at, avoid)
      return this.fetchWord(sel.from, sel.to, blockEnd(state, sel.to), avoid)
    }
    if (level === 4) {
      const text = textOf(this.doc, sel.from, sel.to)
      const sentences = splitAfter(text.trim(), AFTER_STOP).filter(Boolean)
      if (sentences.length > 1) return this.openBar(5, sel.from, sel.to)
      // A word or phrase selected: rewrite the whole sentence around it.
      const p = paragraphAt(state, sel.from)
      const map = textMap(this.doc, p.from, p.to)
      let offset = 0
      while (offset < map.text.length && map.pos(offset) < sel.from) offset++
      const sentence = sentenceAround(map.text, offset)
      const start = map.text.indexOf(sentence)
      return this.fetchRewrite(4, map.pos(start), map.pos(start + sentence.length), '')
    }
    return this.openBar(5, sel.empty ? para.from : sel.from, sel.empty ? para.to : sel.to)
  }

  /** Is the position inside a node of this type? */
  private inBlock(pos: number, type: string) {
    const $pos = this.doc.resolve(pos)
    for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === type) return true
    return false
  }

  /** Where the caret is, for planCaret, and the positions acting on it needs. */
  private caretInfo() {
    const { state } = this.view
    const doc = this.doc
    const head = state.selection.head
    const $pos = state.selection.$head
    const para = paragraphAt(state, head)
    let block: Block = 'paragraph'
    let item: { depth: number; type: 'listItem' | 'taskItem' } | null = null
    for (let d = $pos.depth; d > 0; d--) {
      const name = $pos.node(d).type.name
      if (name === 'codeBlock' && block === 'paragraph') block = 'code'
      else if (name === 'heading' && block === 'paragraph') block = 'heading'
      else if (name === 'table') block = 'table'
      else if ((name === 'listItem' || name === 'taskItem') && !item) item = { depth: d, type: name }
    }
    if (item && block === 'paragraph') block = 'listItem'

    // The word being typed, only when real letters touch the caret (not a page link or a line break).
    const before = $pos.nodeBefore?.isText ? textOf(doc, para.from, head) : ''
    const after = $pos.nodeAfter?.isText ? textOf(doc, head, para.to) : ''
    const { partial, suffix } = wordAtCaret(before, after)

    // The nearest earlier block with text in it, for an empty line.
    let previous: { from: number; to: number } | null = null
    doc.nodesBetween(0, para.from, (node, pos) => {
      if (node.isTextblock && pos + node.nodeSize <= para.from && node.textContent.trim()) previous = { from: pos + 1, to: pos + node.nodeSize - 1 }
      return !node.isTextblock
    })

    const caret: Caret = {
      block,
      text: textOf(doc, para.from, para.to),
      atEnd: !textOf(doc, head, para.to).trim(),
      partial,
      suffix,
      lineStart: $pos.nodeBefore?.type.name === 'hardBreak',
      hasPrevious: previous !== null,
      hasOwn: hasOwnSentence(ownText(doc)),
      title: this.opts.title(),
    }
    return { caret, head, para, previous: previous as { from: number; to: number } | null, item }
  }

  /** Nothing selected: what each level does depends on where the caret is (the table at the top). */
  private atCaret(level: Level, avoid: string[]) {
    const info = this.caretInfo()
    const { caret, head, para, previous } = info
    const plan = planCaret(level, caret, isCompleteWord)
    switch (plan.do) {
      case 'notice':
        return this.notice(level, head, NOTICES[plan.text]())
      case 'recall':
        if (plan.on === 'previous' && previous) return this.fetchRecall(previous.from, previous.to)
        if (plan.on === 'title') return this.fetchRecall(head, head, caret.title)
        return this.fetchRecall(para.from, para.to)
      case 'nudge':
        if (plan.on === 'next' && previous) return this.fetchNudge(head, head, avoid, { scope: textOf(this.doc, previous.from, previous.to), nextParagraph: true })
        if (plan.on === 'opening') return this.fetchNudge(head, head, avoid, { level: 2, scope: caret.title || caret.text, opening: true, count: 1 })
        return this.fetchNudge(para.from, para.to, avoid)
      case 'questions':
        return this.fetchQuestions(level, head, caret.title || caret.text, avoid)
      case 'word':
        if (plan.mode === 'complete') return this.fetchCompletion(head - caret.partial.length, head + caret.suffix.length, caret.partial, caret.suffix, avoid)
        return this.fetchNextWord(head, avoid, plan.mode === 'opener')
      case 'ghost':
      case 'continue':
        if (plan.place === 'wordEnd') {
          // Step past the rest of the word first, so the caret and the ghost meet where the text goes.
          this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.doc, head + caret.suffix.length)))
          return this.fetchGhost(level === 5 ? 5 : 4, 'inline', plan.list, this.caretInfo(), avoid)
        }
        return this.fetchGhost(level === 5 ? 5 : 4, plan.place, plan.list, info, avoid)
      case 'bar':
        return this.openBar(5, para.from, para.to, plan.hint)
    }
  }

  /**
   * A help key pressed in the title. ⌘3 with a draft of 3+ sentences suggests a title (or, for kinds
   * whose title isn't published, an opening line) drawn from the draft; every other key moves into
   * the text and runs there (see titleHelp() in lib/edge.ts). ⌘1 and ⌘2 look at the first paragraph;
   * ⌘3–⌘5 carry on from the end of the writer's last paragraph, never between two they have written.
   */
  requestFromTitle(level: Level) {
    const current = this.help
    if (level === 3 && current?.kind === 'edge' && (current.slot === 'title' || current.slot === 'opening')) {
      this.view.focus()
      return this.request(3)
    }
    const plan = titleHelp(level, sentencesOf(this.draftText()).length, this.opts.ceiling(), this.opts.platform())
    if (plan.mode === 'edge') {
      this.view.focus()
      return this.fetchEdge(plan.slot, [])
    }
    const target = level <= 2 ? this.titleTarget('first') : (this.titleTarget('last') ?? this.titleTarget('first'))
    const sel = target === null ? TextSelection.atStart(this.doc) : TextSelection.create(this.doc, target)
    this.view.dispatch(this.view.state.tr.setSelection(sel).scrollIntoView())
    this.view.focus()
    this.request(level)
  }

  /**
   * Where a key from the title runs: the end of the first paragraph (any text block, if there is no
   * paragraph), or the end of the last paragraph with the writer's own words in it.
   */
  private titleTarget(which: 'first' | 'last'): number | null {
    let first: number | null = null
    let firstBlock: number | null = null
    let last: number | null = null
    this.doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock' || node.type.name === 'blockquote' || node.type.name === 'table') return false
      if (!node.isTextblock) return true
      const end = pos + node.nodeSize - 1
      firstBlock ??= end
      if (node.type.name === 'paragraph') {
        first ??= end
        if (node.textContent.trim() && !isPromptBlock(node)) last = end
      }
      return false
    })
    return which === 'first' ? (first ?? firstBlock) : last
  }

  /** The writer's own prose: paragraphs and list items, not headings, code or template prompts. */
  draftText() {
    const parts: string[] = []
    this.doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock' || node.type.name === 'heading') return false
      if (node.type.name !== 'paragraph') return true
      const text = textOf(this.doc, pos + 1, pos + node.nodeSize - 1).trim()
      if (text && !isPromptParagraph(text)) parts.push(text)
      return false
    })
    return parts.join('\n\n')
  }

  /** The first paragraph of the text: where an opening line goes. */
  private firstParagraph() {
    let found: { from: number; to: number } | null = null
    this.doc.descendants((node, pos) => {
      if (found) return false
      if (node.type.name === 'paragraph' && !isPromptParagraph(node.textContent)) {
        found = { from: pos + 1, to: pos + node.nodeSize - 1 }
        return false
      }
      return node.type.name !== 'codeBlock' && node.type.name !== 'heading'
    })
    return found as { from: number; to: number } | null
  }

  /** Ask for edge lines for a slot. The card sits at the top of the page, under the title. */
  async fetchEdge(slot: EdgeSlot, seen: string[]) {
    const para = slot === 'opening' ? this.firstParagraph() : null
    const from = para?.from ?? 0
    const to = para?.to ?? 0
    const label = edgeLabel(slot)
    // Asking for more keeps the card that's open, in case the draft has nothing new to offer.
    const shown = this.help?.kind === 'edge' && this.help.slot === slot ? this.help : null
    const id = ++this.seq
    this.set({ kind: 'loading', level: 3, from, to, at: 0, label })
    this.slowTimer = window.setTimeout(() => {
      const h = this.help
      if (id === this.seq && h?.kind === 'loading') this.view.dispatch(setHelp(this.view.state.tr, { ...h, slow: true }))
    }, 8000)
    this.view.dispatch(this.view.state.tr.scrollIntoView())
    document.querySelector('.page-area')?.scrollTo({ top: 0 })
    try {
      const r = await fetch('/api/edge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot, text: this.draftText(), kind: this.opts.platform(), current: this.edgeCurrent(slot), avoid: seen }),
      })
      const data = (await r.json()) as EdgeResp & { error?: string }
      if (id !== this.seq) return
      if (data.error) throw new Error(data.error)
      if (data.kind === 'error') throw new Error(data.message)
      if (data.kind === 'empty') {
        if (shown && seen.length) return this.set({ ...shown, note: data.message })
        this.record({ level: 3, from, outcome: 'empty', detail: `${EDGE_NAMES[slot]}: ${data.message}` })
        return this.set({ kind: 'notice', level: 3, from, to, at: 0, text: data.message, label })
      }
      this.set({ kind: 'edge', level: 3, slot, from, to, at: 0, options: data.candidates, sel: 0, seen })
      this.record({ level: 3, from, outcome: 'shown', detail: `${EDGE_NAMES[slot]} · ${data.candidates.length} from your draft` })
    } catch (e) {
      if (id !== this.seq) return
      const msg = (e as Error).message
      this.record({ level: 3, from, outcome: 'error', detail: msg })
      this.set({ kind: 'notice', level: 3, from, to, at: 0, text: friendlyError(msg), tone: 'error', label })
    }
  }

  /** What a slot says now: the field's value, or for an opening line, the first sentence. */
  private edgeCurrent(slot: EdgeSlot) {
    if (slot !== 'opening') return this.opts.edgeCurrent?.(slot) ?? ''
    const para = this.firstParagraph()
    return para ? (sentencesOf(textOf(this.doc, para.from, para.to))[0] ?? '') : ''
  }

  /** Use a candidate: a title, subject or excerpt goes to the writer's field; an opening line is proposed on the page. */
  private pickEdge(i: number) {
    const h = this.help
    if (h?.kind !== 'edge') return
    const c = h.options[i]
    if (!c) return
    if (h.slot !== 'opening') {
      this.set(null)
      this.opts.acceptEdge?.(h.slot, c.text)
      this.record({ level: 3, from: h.from, outcome: 'accepted', detail: `${EDGE_NAMES[h.slot]}: ${c.text}` })
      return
    }
    const para = this.firstParagraph()
    if (!para) return this.set(null)
    const original = textOf(this.doc, para.from, para.to)
    const hunks = computeHunks(original, openingEdit(original, c.text, c.source))
    const at = blockEnd(this.view.state, para.to)
    if (!hunks.some((x) => x.kind === 'chg')) return this.set({ kind: 'notice', level: 3, from: para.from, to: para.to, at, text: 'That’s already how it opens', label: edgeLabel('opening') })
    this.set({ kind: 'diff', level: 3, from: para.from, to: para.to, at, original, hunks, focus: -1, instruction: '', bar: false, sideBySide: changedRatio(original, hunks) > 0.6 })
    this.view.focus()
  }

  /** Is there room to the right of the text column for a margin note? */
  private marginRoom() {
    const content = this.view.dom.getBoundingClientRect()
    const area = this.view.dom.closest('.page-area')?.getBoundingClientRect()
    return area ? area.right - content.right >= 270 : false
  }

  resolve() {
    this.resolveNudge()
  }

  private notice(level: Level, at: number, text: string, tone?: 'error') {
    this.set({ kind: 'notice', level, from: at, to: at, at: blockEnd(this.view.state, at), text, tone })
  }

  private context(from: number, to: number) {
    const size = this.doc.content.size
    return { before: textOf(this.doc, 0, from).slice(-3000), after: textOf(this.doc, to, size).slice(0, 1500) }
  }

  /** Ask the server. Every request carries the document, its kind and its title. */
  private async post(level: Level, body: Record<string, unknown>): Promise<Resp> {
    let r: Response
    try {
      r = await fetch('/api/help', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level, doc: this.opts.doc(), platform: this.opts.platform(), title: this.opts.title(), ...body }),
      })
    } catch {
      throw new Error(SERVER_DOWN)
    }
    const data = (await r.json().catch(() => ({ error: SERVER_DOWN }))) as Resp & { error?: string }
    if (data.error) throw new Error(data.error)
    if (data.kind === 'error') throw Object.assign(new Error(data.message), { provider: data.provider })
    return data
  }

  private friendly(e: unknown) {
    return friendlyError((e as Error).message, (e as { provider?: string }).provider ?? this.opts.provider())
  }

  /**
   * Ask, showing a loading line until the answer comes. The answer is dropped when the request was
   * cancelled meanwhile: by another request, by Esc, or by the writer typing or (for a request at the
   * caret) moving the caret, which clears the loading line. `where` is where the answer goes now:
   * Recall and a Nudge follow the text through edits made while they were asked for.
   */
  private async call(level: Level, from: number, to: number, at: number, body: Record<string, unknown>, caret?: number): Promise<(Resp & { where: { from: number; to: number; at: number } }) | null> {
    const id = ++this.seq
    this.set({ kind: 'loading', level, from, to, at, ...(caret === undefined ? {} : { caret }) })
    this.slowTimer = window.setTimeout(() => {
      const h = this.help
      if (id === this.seq && h?.kind === 'loading') this.view.dispatch(setHelp(this.view.state.tr, { ...h, slow: true }))
    }, 8000)
    const allowed = this.allowOnce === level
    try {
      const data = await this.post(level, body).finally(() => {
        if (id === this.seq && allowed) this.allowOnce = null
      })
      const where = this.stillAsking(id)
      if (!where) return null // cancelled or superseded
      if (data.kind === 'empty') {
        this.record({ level, from: where.from, outcome: 'empty', detail: data.message })
        this.set({ kind: 'notice', level, ...where, text: data.message || EMPTY_MESSAGES[level] })
        return null
      }
      return { ...data, where }
    } catch (e) {
      const where = this.stillAsking(id)
      if (!where) return null
      this.record({ level, from: where.from, outcome: 'error', detail: (e as Error).message })
      this.set({ kind: 'notice', level, ...where, text: this.friendly(e), tone: 'error' })
      return null
    }
  }

  /** Is request `id` still the one on the page? Then where its answer goes, as the text is now. */
  private stillAsking(id: number) {
    const h = this.help
    if (id !== this.seq || h?.kind !== 'loading') return null
    return { from: h.from, to: h.to, at: h.at }
  }

  private async fetchRecall(from: number, to: number, scopeText?: string) {
    const scope = scopeText ?? textOf(this.doc, from, to)
    if (!scope.trim()) return this.notice(1, from, 'Put the cursor in a paragraph to recall related material')
    let at = blockEnd(this.view.state, to)
    const res = await this.call(1, from, to, at, { scope })
    if (res?.kind !== 'recall') return
    ;({ from, to, at } = res.where)
    if (!res.results.length) {
      this.record({ level: 1, from, outcome: 'empty' })
      return this.set({ kind: 'notice', level: 1, from, to, at, text: EMPTY_MESSAGES[1] })
    }
    this.set({ kind: 'recall', level: 1, from, to, at, results: res.results, page: 0, sel: 0 })
    this.record({ level: 1, from, outcome: 'shown', sources: res.results.slice(0, 3).map(({ doc, title, folder }) => ({ doc, title, folder })) })
  }

  private async fetchNudge(from: number, to: number, history: string[], ask: { scope?: string } & Record<string, unknown> = {}) {
    const scope = ask.scope ?? textOf(this.doc, from, to)
    if (!scope.trim()) return this.notice(2, from, 'Put the cursor in a paragraph to get a nudge')
    const at = blockEnd(this.view.state, to)
    const res = await this.call(2, from, to, at, { ...this.context(from, to), ...ask, scope, avoid: history })
    if (res?.kind !== 'nudge') return
    const where = res.where
    this.set({ kind: 'nudge', level: 2, ...where, text: res.text, history: [...history, res.text], inMargin: this.marginRoom() })
    this.record({ level: 2, from: where.from, outcome: 'shown', detail: res.text })
  }

  private async fetchWord(from: number, to: number, at: number, seen: string[]) {
    const { state } = this.view
    const para = paragraphAt(state, from)
    const map = textMap(this.doc, para.from, para.to)
    let offset = 0
    while (offset < map.text.length && map.pos(offset) < from) offset++
    const res = await this.call(3, from, to, at, {
      scope: textOf(this.doc, from, to),
      sentence: sentenceAround(map.text, offset),
      avoid: seen,
    })
    if (res?.kind !== 'word') return
    this.set({ kind: 'word', level: 3, mode: 'replace', from, to, at, options: res.alternatives, sel: 0, seen })
  }

  private async fetchNextWord(pos: number, seen: string[], opener = false) {
    const size = this.doc.content.size
    const scope = textOf(this.doc, 0, pos).slice(-1500)
    if (!scope.trim()) return this.notice(3, pos, 'Write a few words first, or select a word to replace')
    const at = blockEnd(this.view.state, pos)
    const newLine = opener && this.view.state.selection.$head.nodeBefore?.type.name === 'hardBreak'
    const res = await this.call(3, pos, pos, at, { scope, after: textOf(this.doc, pos, size).slice(0, 300), next: true, atParagraphStart: opener, newLine, avoid: seen }, pos)
    if (res?.kind !== 'word') return
    this.set({ kind: 'word', level: 3, mode: 'next', from: pos, to: pos, at, options: res.alternatives, sel: 0, seen })
  }

  /** ⌘3 in or right after a word: ways to finish it. The model may say it is already complete, and offer next words. */
  private async fetchCompletion(from: number, to: number, partial: string, suffix: string, seen: string[]) {
    const head = this.view.state.selection.head
    const size = this.doc.content.size
    const at = blockEnd(this.view.state, head)
    const res = await this.call(
      3,
      from,
      to,
      at,
      {
        scope: textOf(this.doc, 0, head).slice(-1500),
        after: textOf(this.doc, to, size).slice(0, 300),
        next: true,
        partial,
        suffix,
        avoid: seen,
      },
      head,
    )
    if (res?.kind !== 'word') return
    if (res.mode === 'next') return this.set({ kind: 'word', level: 3, mode: 'next', from: head, to: head, at, options: res.alternatives, sel: 0, seen })
    this.set({ kind: 'word', level: 3, mode: 'complete', from, to, at, options: res.alternatives, sel: 0, seen })
  }

  /** Before the writer's first sentence, ⌘3–⌘5 offer questions to start from, never prose. */
  private async fetchQuestions(level: Level, pos: number, scope: string, seen: string[]) {
    const at = blockEnd(this.view.state, pos)
    const res = await this.call(level, pos, pos, at, { level: 2, opening: true, count: 3, scope, avoid: seen }, pos)
    if (res?.kind !== 'questions' && res?.kind !== 'nudge') return
    const questions = res.kind === 'questions' ? res.questions : [res.text]
    this.set({ kind: 'questions', level, from: pos, to: pos, at, questions, seen })
    this.reveal()
    this.record({ level, from: pos, outcome: 'shown', detail: questions.join(' · ') })
  }

  /**
   * ⌘4 (a sentence) and ⌘5 (2–4 sentences) as ghost text: on the writer's line, at the start of an
   * empty paragraph, as the first paragraph under a heading, or as the next list item.
   */
  private async fetchGhost(level: 4 | 5, place: Place, list: boolean, info: ReturnType<HelpController['caretInfo']>, seen: string[]) {
    const { head, para, item } = info
    const doc = this.doc
    const size = doc.content.size
    let at = head
    let block: 'paragraph' | 'listItem' | 'taskItem' | undefined
    if (place === 'afterHeading') {
      at = para.after
      block = 'paragraph'
    } else if (place === 'nextItem' && item) {
      at = doc.resolve(head).after(item.depth)
      block = item.type
    }
    // Everything up to where the new text goes, and what already follows it.
    const scopeEnd = block ? (place === 'afterHeading' ? para.to : at) : head
    const scope = textOf(doc, 0, scopeEnd).slice(-3000)
    const after = textOf(doc, block ? at : head, size).slice(0, 800)
    const hint = block ? at : blockEnd(this.view.state, head)
    const res = await this.call(
      level,
      head,
      head,
      hint,
      {
        scope,
        after,
        avoid: seen,
        continue: level === 5,
        atParagraphStart: place !== 'inline',
        newLine: place === 'paragraphStart' && info.caret.lineStart,
        // The caret right after letters: the word may be unfinished, and the model may finish it first.
        partial: place === 'inline' ? info.caret.partial : '',
        list,
        ...(place === 'afterHeading' ? { heading: caretHeading(info.caret.text) } : {}),
      },
      head,
    )
    if (res?.kind !== 'ghost') return
    // call() drops the answer if the writer typed or moved the caret meanwhile, so these positions still hold.
    this.set({ kind: 'ghost', level, from: head, caret: head, at, to: hint, text: res.text, seen, unit: level === 5 && !list ? 'sentence' : 'all', block, taken: '' })
    this.reveal()
  }

  /**
   * Bring the end of a suggestion into view: a long ghost near the bottom of the window would
   * otherwise show grey words with its keys out of sight below them.
   */
  private reveal() {
    requestAnimationFrame(() => {
      const shown = this.view.dom.querySelectorAll<HTMLElement>('.hl-ghost-block, .hl-line.hl-hint, .hl-questions')
      shown[shown.length - 1]?.scrollIntoView({ block: 'nearest' })
    })
  }

  private openBar(level: 4 | 5, from: number, to: number, hint = false) {
    this.seq++
    this.set({ kind: 'bar', level, from, to, busy: false, hint })
  }

  private runInstruction(instruction: string) {
    const h = this.help
    if (!h || (h.kind !== 'bar' && h.kind !== 'diff') || h.level === 3) return
    // Refining always works from the original text, never from the last suggestion.
    this.fetchRewrite(h.level, h.from, h.to, instruction)
  }

  private async fetchRewrite(level: 4 | 5, from: number, to: number, instruction: string) {
    const original = textOf(this.doc, from, to)
    let at = blockEnd(this.view.state, to)
    const id = this.seq + 1
    const keepBar = level === 5
    if (keepBar) this.set({ kind: 'bar', level, from, to, busy: true })
    const res = keepBar
      ? await this.callKeepingBar(level, from, to, { scope: original, instruction, ...this.context(from, to) }, id)
      : await this.call(level, from, to, at, { scope: original, instruction, rewrite: true, ...this.context(from, to) })
    if (res?.kind !== 'rewrite') return
    if (keepBar) {
      // The bar stays open while the model writes, and follows the text through edits. If the writer
      // changed the passage itself meanwhile, the rewrite is of text that is no longer there.
      const h = this.help
      if (h?.kind !== 'bar') return
      ;({ from, to } = h)
      at = blockEnd(this.view.state, to)
      if (textOf(this.doc, from, to) !== original) return this.set({ kind: 'notice', level, from, to, at, text: `The passage changed while help was writing · press ${helpMod}5 to ask again` })
    }
    const hunks = computeHunks(original, res.text)
    if (!hunks.some((x) => x.kind === 'chg')) return this.set({ kind: 'notice', level, from, to, at, text: EMPTY_MESSAGES[level] })
    this.set({ kind: 'diff', level, from, to, at, original, hunks, focus: -1, instruction, bar: keepBar, sideBySide: changedRatio(original, hunks) > 0.6 })
    // Hand the keyboard back to the page so Tab, ↵ and ⌘↵ act on the changes.
    this.view.focus()
  }

  /** Like call(), but leaves the instruction bar on screen with its progress line. */
  private async callKeepingBar(level: Level, from: number, to: number, body: Record<string, unknown>, id: number): Promise<Resp | null> {
    this.seq = id
    const at = blockEnd(this.view.state, to)
    try {
      const data = await this.post(level, body).finally(() => {
        if (id === this.seq && this.allowOnce === level) this.allowOnce = null
      })
      if (id !== this.seq) return null
      if (data.kind === 'empty') {
        this.set({ kind: 'notice', level, from, to, at, text: data.message })
        return null
      }
      return data
    } catch (e) {
      if (id !== this.seq) return null
      this.set({ kind: 'notice', level, from, to, at, text: this.friendly(e), tone: 'error' })
      return null
    }
  }

  // ---- Acting on a suggestion ----------------------------------------------------------------

  /** A transaction made by help itself, which also closes the suggestion. */
  private own(tr: Transaction) {
    return tr.setMeta(helpKey, { help: null } satisfies HelpMeta)
  }

  private pickWord(i: number) {
    const h = this.help
    if (h?.kind !== 'word') return
    let word = h.options[i]
    const original = textOf(this.doc, h.from, h.to)
    if (h.mode === 'next') {
      // Join onto the text with exactly one space, unless the option is punctuation.
      const prev = textOf(this.doc, Math.max(0, h.from - 1), h.from)
      if (prev && !/\s/.test(prev) && !/^[,.;:!?)'’"]/.test(word)) word = ' ' + word
      const next = textOf(this.doc, h.from, Math.min(this.doc.content.size, h.from + 1))
      if (next && /\w/.test(next)) word += ' '
    }
    // Finishing a word replaces the letters typed so far (and any after the caret): no extra space.
    const tr = this.own(this.view.state.tr.insertText(word, h.from, h.to))
    tr.setSelection(TextSelection.create(tr.doc, h.from + word.length))
    this.view.dispatch(tr)
    const detail = h.mode === 'next' ? `next word: ${word.trim()}` : h.mode === 'complete' ? `finished word: ${original} → ${word}` : `${original} → ${word}`
    this.record({ level: 3, from: h.from, outcome: 'accepted', detail })
    this.flash(h.from)
  }

  private insertRecall(i: number) {
    const h = this.help
    if (h?.kind !== 'recall') return
    const r = h.results[i]
    const schema = this.doc.type.schema
    // The quote, then its source as a link to the page it came from (and, for a highlight from the Brain, where in the source).
    const quote = schema.nodes.blockquote.create(
      null,
      schema.nodes.paragraph.create(null, [
        schema.text(r.text.replace(/\s+/g, ' ').trim()),
        schema.nodes.hardBreak.create(),
        schema.text('— '),
        schema.nodes.pageLink.create({ target: r.doc.replace(/\.md$/, ''), label: r.title }),
        ...(r.location ? [schema.text(`, ${r.location}`)] : []),
      ]),
    )
    const tr = this.own(this.view.state.tr.insert(h.at, quote))
    tr.setSelection(TextSelection.near(tr.doc.resolve(h.at + quote.nodeSize)))
    this.view.dispatch(tr.scrollIntoView())
    this.record({ level: 1, from: h.from, outcome: 'inserted', sources: [{ doc: r.doc, title: r.title, folder: r.folder }] })
  }

  private resolveNudge() {
    const h = this.help
    if (h?.kind !== 'nudge') return
    this.record({ level: 2, from: h.from, outcome: 'resolved', detail: h.text })
    this.set(null)
  }

  /**
   * Take some of a ghost: the next sentence (Tab, for ⌘5), one word (⌥→), or all of it (⌘↵, or Tab
   * for ⌘4). What's left stays as a ghost after the caret.
   */
  acceptGhost(how: 'unit' | 'word' | 'all' = 'unit') {
    const h = this.help
    if (h?.kind !== 'ghost') return false
    const text = how === 'word' ? firstWord(h.text) : how === 'all' || h.unit === 'all' ? h.text : splitFirstSentence(h.text)[0]
    const rest = h.text.slice(text.length)
    // Taking a whole continuation of more than a sentence: keep the text as it was first.
    if (!rest.trim() && sentenceCount(h.text) > 1) this.opts.snapshot?.(`before ${helpMod}4 continuation`)
    const tr = this.view.state.tr
    let end: number
    if (h.block) {
      // The first piece makes the new paragraph or list item; the rest continues inside it.
      const schema = tr.doc.type.schema
      const para = schema.nodes.paragraph.create()
      const node = h.block === 'paragraph' ? para : schema.nodes[h.block].create(h.block === 'taskItem' ? { checked: false } : null, para)
      tr.insert(h.at, node)
      const start = h.at + (h.block === 'paragraph' ? 1 : 2)
      end = insertPlain(tr, start, start, text.trimStart())
    } else end = insertPlain(tr, h.at, h.at, text)
    tr.setSelection(TextSelection.create(tr.doc, end))
    const taken = h.taken + text
    const $end = tr.doc.resolve(end)
    const next: Help | null = rest.trim() ? { ...h, block: undefined, from: tr.mapping.map(h.from), caret: end, at: end, to: $end.after($end.depth), text: rest, taken } : null
    this.view.dispatch(setHelp(tr.scrollIntoView(), next))
    if (next) this.reveal()
    else this.recordGhost({ ...h, taken }, 'accepted')
    return true
  }

  moveSelection(delta: number) {
    const h = this.help
    if (h?.kind === 'word' || h?.kind === 'edge') {
      this.set({ ...h, sel: (h.sel + delta + h.options.length) % h.options.length })
      return true
    }
    if (h?.kind === 'recall') {
      const pageStart = h.page * 3
      const pageLen = Math.min(3, h.results.length - pageStart)
      this.set({ ...h, sel: pageStart + ((h.sel - pageStart + delta + pageLen) % pageLen) })
      return true
    }
    return false
  }

  pickSelected() {
    const h = this.help
    if (h?.kind === 'word') {
      this.pickWord(h.sel)
      return true
    }
    if (h?.kind === 'edge') {
      this.pickEdge(h.sel)
      return true
    }
    if (h?.kind === 'recall') {
      this.insertRecall(h.sel)
      return true
    }
    return false
  }

  stepHunk(delta: number) {
    const h = this.help
    if (h?.kind !== 'diff' || h.sideBySide) return false
    const pending = h.hunks.map((x, i) => (x.kind === 'chg' && x.state === 'pending' ? i : -1)).filter((i) => i >= 0)
    if (!pending.length) return true
    const cur = pending.indexOf(h.focus)
    const next = cur < 0 ? (delta > 0 ? pending[0] : pending[pending.length - 1]) : pending[(cur + delta + pending.length) % pending.length]
    this.set({ ...h, focus: next })
    return true
  }

  decideFocused(state: 'accepted' | 'rejected') {
    const h = this.help
    if (h?.kind !== 'diff' || h.focus < 0) return false
    this.decideHunk(h.focus, state)
    return true
  }

  private decideHunk(index: number, state: 'accepted' | 'rejected') {
    const h = this.help
    if (h?.kind !== 'diff') return
    const hunks = h.hunks.map((x, i) => (i === index && x.kind === 'chg' ? { ...x, state } : x))
    const pending = hunks.map((x, i) => (x.kind === 'chg' && x.state === 'pending' ? i : -1)).filter((i) => i >= 0)
    if (!pending.length) return this.commit({ ...h, hunks }, 'rejected')
    const next = pending.find((i) => i > index) ?? pending[0]
    this.set({ ...h, hunks, focus: next })
  }

  /**
   * A change from the Assistant tab, shown with the same word diff as a rewrite: Tab, ↵ and ⌫ decide each
   * change, ⌘↵ takes them all. Accepted from the tab itself, it is applied at once, as one undoable step.
   */
  propose(p: PageProposal): boolean {
    const size = this.doc.content.size
    if (p.from < 0 || p.to > size || p.from > p.to) return false
    const original = textOf(this.doc, p.from, p.to)
    const hunks = computeHunks(original, p.text)
    if (!hunks.some((x) => x.kind === 'chg')) return false
    this.seq++
    this.onProposal = p.onDone
    const at = blockEnd(this.view.state, p.to)
    const help: Extract<Help, { kind: 'diff' }> = {
      kind: 'diff',
      level: p.level,
      from: p.from,
      to: p.to,
      at,
      original,
      hunks,
      focus: -1,
      instruction: p.instruction,
      bar: false,
      sideBySide: changedRatio(original, hunks) > 0.6,
      source: 'assistant',
    }
    if (p.accept) {
      this.commit(help, 'accepted')
      return true
    }
    this.set(help)
    this.view.focus()
    requestAnimationFrame(() => {
      const start = this.view.domAtPos(p.from).node
      ;(start.nodeType === 3 ? start.parentElement : (start as HTMLElement))?.scrollIntoView({ block: 'center' })
    })
    return true
  }

  finishDiff(pending: 'accepted' | 'rejected') {
    const h = this.help
    if (h?.kind !== 'diff') return
    this.commit(h, pending)
  }

  /** Apply the accepted changes, word by word, keeping the formatting of everything around them. */
  private commit(h: Extract<Help, { kind: 'diff' }>, pending: 'accepted' | 'rejected') {
    const map = textMap(this.doc, h.from, h.to)
    const edits: { from: number; to: number; text: string }[] = []
    let offset = 0
    let accepted = 0
    let total = 0
    for (const x of h.hunks) {
      if (x.kind === 'eq') {
        offset += x.text.length
        continue
      }
      total++
      if ((x.state === 'pending' ? pending : x.state) === 'accepted') {
        accepted++
        edits.push({ from: map.pos(offset), to: map.pos(offset + x.del.length), text: x.ins })
      }
      offset += x.del.length
    }
    // A rewrite that replaces more than a sentence: keep the text as it was first.
    const inserted = edits.map((e) => e.text).join(' ')
    if (edits.length && (sentenceCount(h.original) > 1 || sentenceCount(inserted) > 1)) this.opts.snapshot?.(`before ${helpMod}${h.level} rewrite`)
    const tr = this.own(this.view.state.tr)
    // From the end, so earlier positions stay valid.
    for (const e of edits.reverse()) insertPlain(tr, e.from, e.to, e.text)
    this.view.dispatch(tr)
    const outcome = accepted === 0 ? 'rejected' : accepted === total ? 'accepted' : 'partly accepted'
    this.record({
      level: h.level,
      from: h.from,
      outcome,
      instruction: h.instruction || undefined,
      detail: `${h.source === 'assistant' ? 'Assistant · ' : ''}${accepted} of ${total} change${total === 1 ? '' : 's'}`,
    })
    if (h.source === 'assistant') {
      const done = this.onProposal
      this.onProposal = undefined
      done?.(outcome)
    }
    this.view.focus()
  }

  private flash(from: number) {
    // A brief highlight on a replaced word, done with a temporary DOM class.
    requestAnimationFrame(() => {
      const start = this.view.domAtPos(from)
      const node = start.node.nodeType === 3 ? start.node.parentElement : (start.node as HTMLElement)
      node?.classList.add('hl-flash')
      window.setTimeout(() => node?.classList.remove('hl-flash'), 700)
    })
  }

  // ---- The Recall dot ------------------------------------------------------------------------

  /** Call on every cursor move; probes the current paragraph once the writer pauses. */
  onCursor(enabled: boolean) {
    const { state } = this.view
    const para = paragraphAt(state, state.selection.head)
    if (para.from === this.dotPara) return
    this.dotPara = para.from
    window.clearTimeout(this.dotTimer)
    if (dotOf(state) !== null) this.view.dispatch(state.tr.setMeta(helpKey, { dot: null } satisfies HelpMeta))
    if (!enabled) return
    this.dotTimer = window.setTimeout(async () => {
      // The page may have changed since (a rewrite accepted, a version restored): read the paragraph as it is now.
      const now = paragraphAt(this.view.state, this.view.state.selection.head)
      if (now.from !== para.from) return
      const text = textOf(this.doc, now.from, now.to)
      try {
        const r = await fetch('/api/recall-probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, doc: this.opts.doc() }),
        })
        const { strong } = (await r.json()) as { strong: boolean }
        if (strong && this.dotPara === para.from) this.view.dispatch(this.view.state.tr.setMeta(helpKey, { dot: para.from } satisfies HelpMeta))
      } catch {
        /* the dot is optional */
      }
    }, 1500)
  }
}

const NOTICES = {
  code: () => 'Help is off inside code',
  table: () => 'Help is off inside tables',
  firstLine: () => {
    const key = formatKey(binding('thinking'))
    return `Write a line first, or open Thinking Space${key ? ` (${key})` : ''}`
  },
}

/** The writer's own text: paragraphs and list items, leaving out headings, code, quotes and a template's prompts. */
export function ownText(doc: PMNode) {
  const parts: string[] = []
  doc.descendants((node) => {
    if (node.type.name === 'blockquote' || node.type.name === 'codeBlock' || node.type.name === 'heading' || node.type.name === 'table') return false
    if (!node.isTextblock) return true
    if (!isPromptBlock(node)) parts.push(textOf(node, 0, node.content.size))
    return false
  })
  return parts.join('\n\n')
}

/** A template's `*Prompt: …*` paragraph, as the page shows it: emphasised text that opens with "Prompt:". */
function isPromptBlock(node: PMNode) {
  const first = node.firstChild
  return /^\s*Prompt:/i.test(node.textContent) && !!first?.isText && first.marks.some((m) => m.type.name === 'italic' || m.type.name === 'bold')
}

/** A heading's text, for the prompt that opens its section. */
const caretHeading = (text: string) => text.trim().slice(0, 200)
