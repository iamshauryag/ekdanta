// Turns a help keystroke into a request, and the response into a suggestion on the page.
import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
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
  type RecallResult,
} from './help.ts'
import { EDGE_NAMES, openingEdit, sentencesOf, titleHelp, type EdgeCandidate, type EdgeSlot } from '../lib/edge.ts'
import { isPromptParagraph } from '../lib/special.ts'

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
  ceiling: () => number
  record: (item: HistoryItem) => void
  openDoc: (path: string) => void
  /** What a title, subject or excerpt says now, so edge lines don't offer it back. */
  edgeCurrent?: (slot: EdgeSlot) => string
  /** Use an accepted title, subject or excerpt (an opening line is proposed on the page instead). */
  acceptEdge?: (slot: EdgeSlot, text: string) => void
}

type Resp =
  | { kind: 'recall'; results: RecallResult[] }
  | { kind: 'nudge'; text: string }
  | { kind: 'word'; alternatives: string[] }
  | { kind: 'ghost'; text: string }
  | { kind: 'rewrite'; text: string }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string }

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
    if (['recall', 'nudge', 'word', 'ghost', 'edge'].includes(h.kind)) {
      this.record({ level: (h as { level: Level }).level, from: h.from, outcome: 'dismissed' })
    }
    this.set(null)
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

    // Same key again = next suggestion.
    if (current && 'level' in current && current.level === level && current.kind !== 'loading') {
      if (current.kind === 'recall' && current.results.length > (current.page + 1) * 3) {
        this.set({ ...current, page: current.page + 1, sel: (current.page + 1) * 3 })
        return
      }
      if (current.kind === 'word')
        return current.mode === 'next'
          ? this.fetchNextWord(current.from, [...current.seen, ...current.options])
          : this.fetchWord(current.from, current.to, current.at, [...current.seen, ...current.options])
      if (current.kind === 'ghost') return this.fetchGhost(current.at, [...current.seen, current.text])
      // ⌘3 again asks for more titles or opening lines; a subject or excerpt card leaves ⌘3 in the text as it was.
      // Once the draft is used up the card stays as it is, saying so.
      if (current.kind === 'edge' && (current.slot === 'title' || current.slot === 'opening'))
        return current.note ? undefined : this.fetchEdge(current.slot, [...current.seen, ...current.options.map((o) => o.text)])
      if (current.kind === 'nudge') return this.fetchNudge(current.from, current.to, current.history)
    }

    const para = paragraphAt(state, sel.head)
    if (level === 1) return sel.empty ? this.fetchRecall(para.from, para.to) : this.fetchRecall(sel.from, sel.to)
    if (level === 2) return sel.empty ? this.fetchNudge(para.from, para.to, []) : this.fetchNudge(sel.from, sel.to, [])
    if (level === 3) {
      // Nothing selected: what could the next word be? A selection: what could replace it?
      if (sel.empty) return this.fetchNextWord(sel.head, [])
      const text = textOf(this.doc, sel.from, sel.to)
      if (text.split(/\s+/).filter(Boolean).length > 4 || text.includes('\n')) {
        return this.notice(3, sel.to, `${helpMod}3 works on a word or short phrase`)
      }
      return this.fetchWord(sel.from, sel.to, blockEnd(state, sel.to), [])
    }
    if (level === 4) {
      if (sel.empty) return this.fetchGhost(sel.head, [])
      const text = textOf(this.doc, sel.from, sel.to)
      const sentences = text
        .trim()
        .split(/(?<=[.!?])\s+/)
        .filter(Boolean)
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
    return sel.empty ? this.openBar(5, para.from, para.to) : this.openBar(5, sel.from, sel.to)
  }

  /**
   * A help key pressed in the title. ⌘3 with a draft of 3+ sentences suggests a title (or, for kinds
   * whose title isn't published, an opening line) drawn from the draft; every other key moves to the
   * start of the text and runs there. See titleHelp() in lib/edge.ts for the whole table.
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
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.atStart(this.doc)))
    this.view.focus()
    this.request(level)
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

  private async call(level: Level, from: number, to: number, at: number, body: Record<string, unknown>): Promise<Resp | null> {
    const id = ++this.seq
    this.set({ kind: 'loading', level, from, to, at })
    this.slowTimer = window.setTimeout(() => {
      const h = this.help
      if (id === this.seq && h?.kind === 'loading') this.view.dispatch(setHelp(this.view.state.tr, { ...h, slow: true }))
    }, 8000)
    const allowed = this.allowOnce === level
    try {
      const r = await fetch('/api/help', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level, doc: this.opts.doc(), platform: this.opts.platform(), ...body }),
      })
      const data = (await r.json()) as Resp & { error?: string }
      if (id !== this.seq) return null // cancelled or superseded
      if (allowed) this.allowOnce = null
      if (data.error) throw new Error(data.error)
      if (data.kind === 'error') throw new Error(data.message)
      if (data.kind === 'empty') {
        this.record({ level, from, outcome: 'empty', detail: data.message })
        this.set({ kind: 'notice', level, from, to, at, text: data.message || EMPTY_MESSAGES[level] })
        return null
      }
      return data
    } catch (e) {
      if (id !== this.seq) return null
      const msg = (e as Error).message
      this.record({ level, from, outcome: 'error', detail: msg })
      this.set({ kind: 'notice', level, from, to, at, text: friendlyError(msg), tone: 'error' })
      return null
    }
  }

  private async fetchRecall(from: number, to: number) {
    const scope = textOf(this.doc, from, to)
    if (!scope.trim()) return this.notice(1, from, 'Put the cursor in a paragraph to recall related material')
    const at = blockEnd(this.view.state, to)
    const res = await this.call(1, from, to, at, { scope })
    if (res?.kind !== 'recall') return
    if (!res.results.length) {
      this.record({ level: 1, from, outcome: 'empty' })
      return this.set({ kind: 'notice', level: 1, from, to, at, text: EMPTY_MESSAGES[1] })
    }
    this.set({ kind: 'recall', level: 1, from, to, at, results: res.results, page: 0, sel: 0 })
    this.record({ level: 1, from, outcome: 'shown', sources: res.results.slice(0, 3).map(({ doc, title, folder }) => ({ doc, title, folder })) })
  }

  private async fetchNudge(from: number, to: number, history: string[]) {
    const scope = textOf(this.doc, from, to)
    if (!scope.trim()) return this.notice(2, from, 'Put the cursor in a paragraph to get a nudge')
    const at = blockEnd(this.view.state, to)
    const res = await this.call(2, from, to, at, { scope, ...this.context(from, to), avoid: history })
    if (res?.kind !== 'nudge') return
    this.set({ kind: 'nudge', level: 2, from, to, at: blockEnd(this.view.state, to), text: res.text, history: [...history, res.text], inMargin: this.marginRoom() })
    this.record({ level: 2, from, outcome: 'shown', detail: res.text })
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

  private async fetchNextWord(pos: number, seen: string[]) {
    const size = this.doc.content.size
    const scope = textOf(this.doc, 0, pos).slice(-1500)
    if (!scope.trim()) return this.notice(3, pos, 'Write a few words first, or select a word to replace')
    const at = blockEnd(this.view.state, pos)
    const res = await this.call(3, pos, pos, at, { scope, after: textOf(this.doc, pos, size).slice(0, 300), next: true, avoid: seen })
    if (res?.kind !== 'word') return
    this.set({ kind: 'word', level: 3, mode: 'next', from: pos, to: pos, at, options: res.alternatives, sel: 0, seen })
  }

  private async fetchGhost(pos: number, seen: string[]) {
    const size = this.doc.content.size
    const scope = textOf(this.doc, 0, pos).slice(-3000)
    if (!scope.trim()) return this.notice(4, pos, `Write a little first, then ${helpMod}4 can continue it`)
    const end = blockEnd(this.view.state, pos)
    const res = await this.call(4, pos, pos, end, { scope, after: textOf(this.doc, pos, size).slice(0, 800), avoid: seen })
    if (res?.kind !== 'ghost') return
    this.set({ kind: 'ghost', level: 4, from: pos, to: blockEnd(this.view.state, pos), at: pos, text: res.text, seen })
  }

  private openBar(level: 4 | 5, from: number, to: number) {
    this.seq++
    this.set({ kind: 'bar', level, from, to, busy: false })
  }

  private runInstruction(instruction: string) {
    const h = this.help
    if (!h || (h.kind !== 'bar' && h.kind !== 'diff') || h.level === 3) return
    // Refining always works from the original text, never from the last suggestion.
    this.fetchRewrite(h.level, h.from, h.to, instruction)
  }

  private async fetchRewrite(level: 4 | 5, from: number, to: number, instruction: string) {
    const original = textOf(this.doc, from, to)
    const at = blockEnd(this.view.state, to)
    const id = this.seq + 1
    const keepBar = level === 5
    if (keepBar) this.set({ kind: 'bar', level, from, to, busy: true })
    const res = keepBar
      ? await this.callKeepingBar(level, from, to, { scope: original, instruction, ...this.context(from, to) }, id)
      : await this.call(level, from, to, at, { scope: original, instruction, rewrite: true, ...this.context(from, to) })
    if (res?.kind !== 'rewrite') return
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
      const r = await fetch('/api/help', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level, doc: this.opts.doc(), platform: this.opts.platform(), ...body }),
      })
      const data = (await r.json()) as Resp & { error?: string }
      if (id !== this.seq) return null
      if (this.allowOnce === level) this.allowOnce = null
      if (data.error || data.kind === 'error') throw new Error(data.error ?? (data as { message: string }).message)
      if (data.kind === 'empty') {
        this.set({ kind: 'notice', level, from, to, at, text: data.message })
        return null
      }
      return data
    } catch (e) {
      if (id !== this.seq) return null
      this.set({ kind: 'notice', level, from, to, at, text: friendlyError((e as Error).message), tone: 'error' })
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
    const tr = this.own(this.view.state.tr.insertText(word, h.from, h.to))
    tr.setSelection(TextSelection.create(tr.doc, h.from + word.length))
    this.view.dispatch(tr)
    this.record({ level: 3, from: h.from, outcome: 'accepted', detail: h.mode === 'next' ? `next word: ${word.trim()}` : `${original} → ${word}` })
    this.flash(h.from)
  }

  private insertRecall(i: number) {
    const h = this.help
    if (h?.kind !== 'recall') return
    const r = h.results[i]
    const schema = this.doc.type.schema
    // The quote, then its source as a link to the page it came from.
    const quote = schema.nodes.blockquote.create(
      null,
      schema.nodes.paragraph.create(null, [
        schema.text(r.text.replace(/\s+/g, ' ').trim()),
        schema.nodes.hardBreak.create(),
        schema.text('— '),
        schema.nodes.pageLink.create({ target: r.doc.replace(/\.md$/, ''), label: r.title }),
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

  acceptGhost(oneWord = false) {
    const h = this.help
    if (h?.kind !== 'ghost') return false
    let text = h.text
    if (oneWord) text = text.match(/^\s*\S+/)?.[0] ?? text
    const rest = h.text.slice(text.length)
    const tr = this.view.state.tr
    const end = insertPlain(tr, h.at, h.at, text)
    tr.setSelection(TextSelection.create(tr.doc, end))
    const next: Help | null = rest.trim() ? { ...h, from: end, at: end, to: tr.mapping.map(h.to), text: rest } : null
    this.view.dispatch(setHelp(tr, next))
    if (!rest.trim()) this.record({ level: 4, from: h.from, outcome: 'accepted', detail: h.text.trim() })
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
    const tr = this.own(this.view.state.tr)
    // From the end, so earlier positions stay valid.
    for (const e of edits.reverse()) insertPlain(tr, e.from, e.to, e.text)
    this.view.dispatch(tr)
    const outcome = accepted === 0 ? 'rejected' : accepted === total ? 'accepted' : 'partly accepted'
    this.record({ level: h.level, from: h.from, outcome, instruction: h.instruction || undefined, detail: `${accepted} of ${total} change${total === 1 ? '' : 's'}` })
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
      const text = textOf(this.doc, para.from, para.to)
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

function friendlyError(msg: string) {
  if (/ECONNREFUSED|fetch failed|Ollama/i.test(msg)) return 'Couldn’t reach Ollama · start it with `ollama serve`'
  if (/timed out/i.test(msg)) return 'The model took too long · try again'
  if (/rejected/i.test(msg)) return 'Your API key was rejected'
  if (/No model/i.test(msg)) return msg
  return `Something went wrong · ${msg.slice(0, 80)}`
}
