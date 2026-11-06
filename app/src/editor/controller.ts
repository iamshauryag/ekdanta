// Turns a help keystroke into a request, and the response into a suggestion on the page.
import type { EditorView } from '@codemirror/view'
import {
  changedRatio,
  computeHunks,
  helpField,
  helpOwn,
  paragraphAt,
  recallDotField,
  resolveHunks,
  sentenceAround,
  setHelp,
  setRecallDot,
  setWidgetHooks,
  type Help,
  type Level,
  type RecallResult,
  helpMod,
} from './help.ts'

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
}

type Resp =
  | { kind: 'recall'; results: RecallResult[] }
  | { kind: 'nudge'; text: string }
  | { kind: 'word'; alternatives: string[] }
  | { kind: 'ghost'; text: string }
  | { kind: 'rewrite'; text: string }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string }

const EMPTY_MESSAGES: Record<Level, string> = {
  1: 'Nothing in your vault on this yet',
  2: 'No useful nudge here',
  3: 'No better word found',
  4: 'No continuation found',
  5: 'No change suggested',
}

export class HelpController {
  private seq = 0
  private ceilingPrompt: { level: Level; at: number } | null = null
  private allowOnce: Level | null = null
  private slowTimer: number | undefined
  private dotTimer: number | undefined
  private dotPara = -1

  constructor(private view: EditorView, private opts: ControllerOptions) {
    setWidgetHooks({
      runInstruction: (t) => this.runInstruction(t),
      dismiss: () => this.dismiss(),
      pickWord: (i) => this.pickWord(i),
      insertRecall: (i) => this.insertRecall(i),
      openSource: (doc) => this.opts.openDoc(doc),
      resolveNudge: () => this.resolveNudge(),
      decideHunk: (i, s) => this.decideHunk(i, s),
      acceptAll: () => this.finishDiff('accepted'),
      rejectAll: () => this.finishDiff('rejected'),
      stepHunk: (d) => this.stepHunk(d),
      recallAtDot: () => {
        const pos = this.view.state.field(recallDotField)
        if (pos !== null) this.view.dispatch({ selection: { anchor: pos } })
        this.request(1)
      },
    })
  }

  get help(): Help | null {
    return this.view.state.field(helpField)
  }

  private set(help: Help | null) {
    window.clearTimeout(this.slowTimer)
    this.view.dispatch({ effects: setHelp.of(help) })
  }

  private record(item: Omit<HistoryItem, 'at'>) {
    this.opts.record({ ...item, at: new Date().toISOString() })
  }

  dismiss() {
    const h = this.help
    if (!h) return
    this.seq++
    if (h.kind === 'diff') return this.finishDiff('rejected')
    if (['recall', 'nudge', 'word', 'ghost'].includes(h.kind)) {
      this.record({ level: (h as { level: Level }).level, from: h.from, outcome: 'dismissed' })
    }
    this.set(null)
  }

  // ---- Asking -------------------------------------------------------------------------------

  request(level: Level) {
    const { state } = this.view
    const sel = state.selection.main
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
        const text =
          this.opts.ceiling() === 0
            ? 'Help is off · change the ceiling in the Piece panel'
            : `Ceiling is ${this.opts.ceiling()} · press ${helpMod}${level} again to allow once`
        this.set({ kind: 'notice', from: para.from, to: para.to, at: para.to, text })
        return
      }
    }

    // Same key again = next suggestion.
    if (current && 'level' in current && current.level === level && current.kind !== 'loading') {
      if (current.kind === 'recall' && current.results.length > (current.page + 1) * 3) {
        this.set({ ...current, page: current.page + 1, sel: (current.page + 1) * 3 })
        return
      }
      if (current.kind === 'word') return current.mode === 'next'
          ? this.fetchNextWord(current.from, [...current.seen, ...current.options])
          : this.fetchWord(current.from, current.to, current.at, [...current.seen, ...current.options])
      if (current.kind === 'ghost') return this.fetchGhost(current.at, [...current.seen, current.text])
      if (current.kind === 'nudge') return this.fetchNudge(current.from, current.to, current.history)
    }

    if (level === 1) {
      const r = sel.empty ? paragraphAt(state, sel.head) : sel
      return this.fetchRecall(r.from, r.to)
    }
    if (level === 2) {
      const r = sel.empty ? paragraphAt(state, sel.head) : sel
      return this.fetchNudge(r.from, r.to, [])
    }
    if (level === 3) {
      // Nothing selected: what could the next word be? A selection: what could replace it?
      if (sel.empty) return this.fetchNextWord(sel.head, [])
      const { from, to } = sel
      const text = state.sliceDoc(from, to)
      if (text.split(/\s+/).filter(Boolean).length > 4 || text.includes('\n')) {
        return this.notice(3, to, `${helpMod}3 works on a word or short phrase`)
      }
      return this.fetchWord(from, to, state.doc.lineAt(to).to, [])
    }
    if (level === 4) {
      if (sel.empty) return this.fetchGhost(sel.head, [])
      const text = state.sliceDoc(sel.from, sel.to)
      const sentences = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean)
      if (sentences.length > 1) return this.openBar(5, sel.from, sel.to)
      // A word or phrase selected: rewrite the whole sentence around it.
      const para = paragraphAt(state, sel.from)
      const paraText = state.sliceDoc(para.from, para.to)
      const sentence = sentenceAround(paraText, sel.from - para.from)
      const start = para.from + paraText.indexOf(sentence)
      return this.fetchRewrite(4, start, start + sentence.length, '')
    }
    const r = sel.empty ? paragraphAt(state, sel.head) : sel
    return this.openBar(5, r.from, r.to)
  }

  /** Is there room to the right of the text column for a margin note? */
  private marginRoom() {
    const content = this.view.contentDOM.getBoundingClientRect()
    const area = this.view.dom.closest('.page-area')?.getBoundingClientRect()
    return area ? area.right - content.right >= 270 : false
  }

  resolve() {
    this.resolveNudge()
  }

  private notice(level: Level, at: number, text: string, tone?: 'error') {
    const line = this.view.state.doc.lineAt(at)
    this.set({ kind: 'notice', level, from: at, to: at, at: line.to, text, tone })
  }

  private context(from: number, to: number) {
    const doc = this.view.state.doc
    return { before: doc.sliceString(Math.max(0, from - 3000), from), after: doc.sliceString(to, Math.min(doc.length, to + 1500)) }
  }

  private async call(level: Level, from: number, to: number, at: number, body: Record<string, unknown>): Promise<Resp | null> {
    const id = ++this.seq
    this.set({ kind: 'loading', level, from, to, at })
    this.slowTimer = window.setTimeout(() => {
      const h = this.help
      if (id === this.seq && h?.kind === 'loading') this.view.dispatch({ effects: setHelp.of({ ...h, slow: true }) })
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
    const scope = this.view.state.sliceDoc(from, to)
    if (!scope.trim()) return this.notice(1, from, 'Put the cursor in a paragraph to recall related material')
    const at = this.view.state.doc.lineAt(to).to
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
    const scope = this.view.state.sliceDoc(from, to)
    if (!scope.trim()) return this.notice(2, from, 'Put the cursor in a paragraph to get a nudge')
    const res = await this.call(2, from, to, this.view.state.doc.lineAt(to).to, { scope, ...this.context(from, to), avoid: history })
    if (res?.kind !== 'nudge') return
    const at = this.view.state.doc.lineAt(to).to
    this.set({ kind: 'nudge', level: 2, from, to, at, text: res.text, history: [...history, res.text], inMargin: this.marginRoom() })
    this.record({ level: 2, from, outcome: 'shown', detail: res.text })
  }

  private async fetchWord(from: number, to: number, at: number, seen: string[]) {
    const { state } = this.view
    const para = paragraphAt(state, from)
    const paraText = state.sliceDoc(para.from, para.to)
    const res = await this.call(3, from, to, at, {
      scope: state.sliceDoc(from, to),
      sentence: sentenceAround(paraText, from - para.from),
      avoid: seen,
    })
    if (res?.kind !== 'word') return
    this.set({ kind: 'word', level: 3, mode: 'replace', from, to, at, options: res.alternatives, sel: 0, seen })
  }

  private async fetchNextWord(pos: number, seen: string[]) {
    const doc = this.view.state.doc
    const scope = doc.sliceString(Math.max(0, pos - 1500), pos)
    if (!scope.trim()) return this.notice(3, pos, 'Write a few words first, or select a word to replace')
    const at = doc.lineAt(pos).to
    const res = await this.call(3, pos, pos, at, { scope, after: doc.sliceString(pos, Math.min(doc.length, pos + 300)), next: true, avoid: seen })
    if (res?.kind !== 'word') return
    this.set({ kind: 'word', level: 3, mode: 'next', from: pos, to: pos, at, options: res.alternatives, sel: 0, seen })
  }

  private async fetchGhost(pos: number, seen: string[]) {
    const doc = this.view.state.doc
    const scope = doc.sliceString(Math.max(0, pos - 3000), pos)
    if (!scope.trim()) return this.notice(4, pos, `Write a little first, then ${helpMod}4 can continue it`)
    const line = doc.lineAt(pos)
    const res = await this.call(4, pos, pos, line.to, { scope, after: doc.sliceString(pos, Math.min(doc.length, pos + 800)), avoid: seen })
    if (res?.kind !== 'ghost') return
    this.set({ kind: 'ghost', level: 4, from: pos, to: line.to, at: pos, text: res.text, seen })
  }

  private openBar(level: 4 | 5, from: number, to: number) {
    this.seq++
    this.set({ kind: 'bar', level, from, to, busy: false })
  }

  private runInstruction(instruction: string) {
    const h = this.help
    if (!h || (h.kind !== 'bar' && h.kind !== 'diff')) return
    // Refining always works from the original text, never from the last suggestion.
    const from = h.from
    const to = h.kind === 'diff' ? h.from + h.original.length : h.to
    this.fetchRewrite(h.level, from, to, instruction)
  }

  private async fetchRewrite(level: 4 | 5, from: number, to: number, instruction: string) {
    const { state } = this.view
    const original = state.sliceDoc(from, to)
    const at = state.doc.lineAt(to).to
    const id = this.seq + 1
    const keepBar = level === 5
    if (keepBar) this.set({ kind: 'bar', level, from, to, busy: true })
    const res = keepBar
      ? await this.callKeepingBar(level, from, to, { scope: original, instruction, ...this.context(from, to) }, id)
      : await this.call(level, from, to, at, { scope: original, instruction, rewrite: true, ...this.context(from, to) })
    if (res?.kind !== 'rewrite') return
    const hunks = computeHunks(original, res.text)
    const firstChange = hunks.findIndex((x) => x.kind === 'chg')
    if (firstChange < 0) return this.set({ kind: 'notice', level, from, to, at, text: EMPTY_MESSAGES[level] })
    this.set({
      kind: 'diff',
      level,
      from,
      to,
      at,
      original,
      hunks,
      focus: -1,
      instruction,
      bar: keepBar,
      sideBySide: changedRatio(original, hunks) > 0.6,
    })
    // Hand the keyboard back to the page so Tab, ↵ and ⌘↵ act on the changes.
    this.view.focus()
  }

  /** Like call(), but leaves the instruction bar on screen with its progress line. */
  private async callKeepingBar(level: Level, from: number, to: number, body: Record<string, unknown>, id: number): Promise<Resp | null> {
    this.seq = id
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
        this.set({ kind: 'notice', level, from, to, at: this.view.state.doc.lineAt(to).to, text: data.message })
        return null
      }
      return data
    } catch (e) {
      if (id !== this.seq) return null
      this.set({ kind: 'notice', level, from, to, at: this.view.state.doc.lineAt(to).to, text: friendlyError((e as Error).message), tone: 'error' })
      return null
    }
  }

  // ---- Acting on a suggestion ----------------------------------------------------------------

  private pickWord(i: number) {
    const h = this.help
    if (h?.kind !== 'word') return
    let word = h.options[i]
    const original = this.view.state.sliceDoc(h.from, h.to)
    if (h.mode === 'next') {
      // Join onto the text with exactly one space, unless the option is punctuation.
      const prev = this.view.state.sliceDoc(Math.max(0, h.from - 1), h.from)
      if (prev && !/\s/.test(prev) && !/^[,.;:!?)'’"]/.test(word)) word = ' ' + word
      const next = this.view.state.sliceDoc(h.from, h.from + 1)
      if (next && /\w/.test(next)) word += ' '
    }
    this.view.dispatch({
      changes: { from: h.from, to: h.to, insert: word },
      selection: { anchor: h.from + word.length },
      annotations: helpOwn.of(true),
      effects: setHelp.of(null),
    })
    this.record({ level: 3, from: h.from, outcome: 'accepted', detail: h.mode === 'next' ? `next word: ${word.trim()}` : `${original} → ${word}` })
    this.flash(h.from, h.from + word.length)
  }

  private insertRecall(i: number) {
    const h = this.help
    if (h?.kind !== 'recall') return
    const r = h.results[i]
    const quote = `\n\n> ${r.text.replace(/\s+/g, ' ').trim()}\n> — [[${r.doc.replace(/\.md$/, '')}|${r.title}]]\n\n`
    const pos = h.to
    this.view.dispatch({
      changes: { from: pos, insert: quote },
      selection: { anchor: pos + quote.length - 1 },
      annotations: helpOwn.of(true),
      effects: setHelp.of(null),
    })
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
    this.view.dispatch({
      changes: { from: h.at, insert: text },
      selection: { anchor: h.at + text.length },
      annotations: helpOwn.of(true),
      effects: setHelp.of(rest.trim() ? { ...h, from: h.at + text.length, at: h.at + text.length, to: h.to + text.length, text: rest } : null),
    })
    if (!rest.trim()) this.record({ level: 4, from: h.from, outcome: 'accepted', detail: h.text.trim() })
    return true
  }

  moveSelection(delta: number) {
    const h = this.help
    if (h?.kind === 'word') {
      const sel = (h.sel + delta + h.options.length) % h.options.length
      this.set({ ...h, sel })
      return true
    }
    if (h?.kind === 'recall') {
      const pageStart = h.page * 3
      const pageLen = Math.min(3, h.results.length - pageStart)
      const sel = pageStart + ((h.sel - pageStart + delta + pageLen) % pageLen)
      this.set({ ...h, sel })
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

  private commit(h: Extract<Help, { kind: 'diff' }>, pending: 'accepted' | 'rejected') {
    const text = resolveHunks(h.hunks, pending)
    const changes = h.hunks.filter((x) => x.kind === 'chg') as Extract<(typeof h.hunks)[number], { kind: 'chg' }>[]
    const accepted = changes.filter((x) => (x.state === 'pending' ? pending : x.state) === 'accepted').length
    const outcome = accepted === 0 ? 'rejected' : accepted === changes.length ? 'accepted' : 'partly accepted'
    this.view.dispatch({
      changes: text === h.original ? undefined : { from: h.from, to: h.from + h.original.length, insert: text },
      annotations: helpOwn.of(true),
      effects: setHelp.of(null),
    })
    this.record({
      level: h.level,
      from: h.from,
      outcome,
      instruction: h.instruction || undefined,
      detail: `${accepted} of ${changes.length} change${changes.length === 1 ? '' : 's'}`,
    })
    this.view.focus()
  }

  private flash(from: number, to: number) {
    // A brief highlight on a replaced word, done with a temporary DOM class.
    requestAnimationFrame(() => {
      const start = this.view.domAtPos(from)
      const node = start.node.nodeType === 3 ? start.node.parentElement : (start.node as HTMLElement)
      node?.classList.add('hl-flash')
      window.setTimeout(() => node?.classList.remove('hl-flash'), 700)
    })
    void to
  }

  // ---- The Recall dot ------------------------------------------------------------------------

  /** Call on every cursor move; probes the current paragraph once the writer pauses. */
  onCursor(enabled: boolean) {
    const { state } = this.view
    const para = paragraphAt(state, state.selection.main.head)
    if (para.from === this.dotPara) return
    this.dotPara = para.from
    window.clearTimeout(this.dotTimer)
    if (state.field(recallDotField) !== null) this.view.dispatch({ effects: setRecallDot.of(null) })
    if (!enabled) return
    this.dotTimer = window.setTimeout(async () => {
      const text = this.view.state.sliceDoc(para.from, para.to)
      try {
        const r = await fetch('/api/recall-probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, doc: this.opts.doc() }),
        })
        const { strong } = (await r.json()) as { strong: boolean }
        if (strong && this.dotPara === para.from) this.view.dispatch({ effects: setRecallDot.of(para.from) })
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
