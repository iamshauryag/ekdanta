// The help ladder inside CodeMirror. Suggestions live in a StateField and are drawn as
// decorations, so the writer's text is never touched until they accept something.
import { Annotation, StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { diffWordsWithSpace } from 'diff'

export type Level = 1 | 2 | 3 | 4 | 5

export interface RecallResult {
  doc: string
  title: string
  folder: string
  text: string
  score: number
}

export type Hunk =
  | { kind: 'eq'; text: string }
  | { kind: 'chg'; del: string; ins: string; state: 'pending' | 'accepted' | 'rejected' }

export type Help =
  | { kind: 'loading'; level: Level; from: number; to: number; at: number; slow?: boolean }
  | { kind: 'notice'; level?: Level; from: number; to: number; at: number; text: string; tone?: 'error' }
  | { kind: 'recall'; level: 1; from: number; to: number; at: number; results: RecallResult[]; page: number; sel: number }
  | { kind: 'nudge'; level: 2; from: number; to: number; at: number; text: string; history: string[]; inMargin: boolean }
  | { kind: 'word'; level: 3; mode: 'replace' | 'next'; from: number; to: number; at: number; options: string[]; sel: number; seen: string[] }
  | { kind: 'ghost'; level: 4; from: number; to: number; at: number; text: string; seen: string[] }
  | { kind: 'bar'; level: 4 | 5; from: number; to: number; busy: boolean }
  | {
      kind: 'diff'
      level: 4 | 5
      from: number
      to: number
      at: number
      original: string
      hunks: Hunk[]
      focus: number // index into hunks (a 'chg'), or -1
      instruction: string
      bar: boolean // keep the instruction bar open above, for refining
      sideBySide: boolean
    }

export const setHelp = StateEffect.define<Help | null>()
/** Marks transactions made by the help system itself (accepting, inserting). */
export const helpOwn = Annotation.define<boolean>()

export const helpField = StateField.define<Help | null>({
  create: () => null,
  update(help, tr) {
    for (const e of tr.effects) if (e.is(setHelp)) return e.value
    if (!help) return help
    if (tr.docChanged) {
      // Typing wins: any edit dismisses the suggestion. A Nudge covers nothing, so it stays.
      if (help.kind === 'nudge') {
        return { ...help, from: tr.changes.mapPos(help.from, -1), to: tr.changes.mapPos(help.to, 1), at: tr.changes.mapPos(help.at, 1) }
      }
      if (help.kind === 'bar') return { ...help, from: tr.changes.mapPos(help.from, -1), to: tr.changes.mapPos(help.to, 1) }
      return null
    }
    if (tr.selection && (help.kind === 'ghost' || help.kind === 'word')) {
      // Moving away from a word list or ghost text dismisses it.
      const head = tr.state.selection.main.head
      if (help.kind === 'ghost' && head !== help.at) return null
      if (help.kind === 'word' && (head < help.from || head > help.to)) return null
    }
    return help
  },
  provide: (f) => EditorView.decorations.from(f, (help) => (help ? buildDecorations(help) : Decoration.none)),
})

// ---- Recall dot: the one passive signal ----------------------------------------------------

export const setRecallDot = StateEffect.define<number | null>()
export const recallDotField = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    for (const e of tr.effects) if (e.is(setRecallDot)) return e.value
    return pos === null ? null : tr.changes.mapPos(pos, -1)
  },
  provide: (f) =>
    EditorView.decorations.from(f, (pos) =>
      pos === null ? Decoration.none : Decoration.set([Decoration.widget({ widget: new DotWidget(), side: -1 }).range(pos)]),
    ),
})

// ---- Hooks the widgets call back into (set by the controller) ------------------------------

export interface WidgetHooks {
  runInstruction(text: string): void
  dismiss(): void
  pickWord(index: number): void
  insertRecall(index: number): void
  openSource(doc: string): void
  resolveNudge(): void
  decideHunk(index: number, state: 'accepted' | 'rejected'): void
  acceptAll(): void
  rejectAll(): void
  recallAtDot(): void
  stepHunk(delta: number): void
}

let hooks: WidgetHooks | null = null
export function setWidgetHooks(h: WidgetHooks) {
  hooks = h
}

// ---- Decorations ----------------------------------------------------------------------------

const LEVEL_NAMES: Record<Level, string> = { 1: 'Recall', 2: 'Nudge', 3: 'Word', 4: 'Sentence', 5: 'Passage' }
/**
 * ⌘1–⌘5 is the intended shortcut, but some browsers keep ⌘+number for switching tabs.
 * The first time ⌘+number reaches the page we know it works here and label everything with ⌘;
 * until then labels show ⌥, which always works.
 */
export let helpMod: '⌘' | '⌥' = (() => {
  try {
    return localStorage.getItem('ekdanta.helpMod') === '⌘' ? '⌘' : '⌥'
  } catch {
    return '⌥'
  }
})()
export function noteCmdWorks() {
  if (helpMod === '⌘') return
  helpMod = '⌘'
  try {
    localStorage.setItem('ekdanta.helpMod', '⌘')
  } catch {
    /* labels fall back to ⌥ next time */
  }
  window.dispatchEvent(new Event('ekdanta:helpmod'))
}
export const levelLabel = (l: Level) => `${helpMod}${l} · ${LEVEL_NAMES[l]}`

function buildDecorations(help: Help): DecorationSet {
  const d: Range<Decoration>[] = []
  const scope = (from: number, to: number) => {
    if (to > from) d.push(Decoration.mark({ class: 'cm-scope' }).range(from, to))
  }
  const block = (at: number, widget: WidgetType, side = 1) => d.push(Decoration.widget({ widget, block: true, side }).range(at))

  switch (help.kind) {
    case 'loading':
      scope(help.from, help.to)
      block(help.at, new LineWidget(`${levelLabel(help.level)}`, help.slow ? 'Still working · Esc to cancel' : '', 'loading'))
      break
    case 'notice':
      if (help.level) scope(help.from, help.to)
      block(help.at, new LineWidget(help.level ? levelLabel(help.level) : '', help.text, help.tone === 'error' ? 'error' : 'notice'))
      break
    case 'recall':
      scope(help.from, help.to)
      block(help.at, new RecallWidget(help))
      break
    case 'nudge':
      scope(help.from, help.to)
      // In the margin when there's room beside the column; otherwise a quiet line under the paragraph.
      if (help.inMargin) d.push(Decoration.widget({ widget: new NudgeWidget(help.text, true), side: -1 }).range(help.from))
      else block(help.at, new NudgeWidget(help.text, false))
      break
    case 'word':
      if (help.to > help.from) d.push(Decoration.mark({ class: 'cm-scope cm-scope-word' }).range(help.from, help.to))
      block(help.at, new WordWidget(help))
      break
    case 'ghost':
      d.push(Decoration.widget({ widget: new GhostWidget(help.text), side: 1 }).range(help.at))
      block(help.to, new LineWidget(levelLabel(4), `Tab accept · ⌥→ one word · ${helpMod}4 next · Esc`, 'hint'))
      break
    case 'bar':
      scope(help.from, help.to)
      block(help.from, new BarWidget(help.busy), -1)
      break
    case 'diff':
      if (help.bar) block(help.from, new BarWidget(false), -1)
      if (help.sideBySide) {
        d.push(Decoration.replace({ widget: new SideBySideWidget(help), block: true }).range(help.from, help.to))
      } else {
        let pos = help.from
        help.hunks.forEach((h, i) => {
          if (h.kind === 'eq') {
            pos += h.text.length
            return
          }
          const end = pos + h.del.length
          const focused = i === help.focus ? ' is-focus' : ''
          if (h.state === 'accepted') {
            if (h.del) d.push(Decoration.replace({ widget: new InsWidget(h.ins, 'accepted', i) }).range(pos, end))
            else d.push(Decoration.widget({ widget: new InsWidget(h.ins, 'accepted', i), side: 1 }).range(pos))
          } else if (h.state === 'rejected') {
            // Shown as the original text: nothing to draw.
          } else {
            if (h.del) d.push(Decoration.mark({ class: 'cm-del' + focused, attributes: { 'data-hunk': String(i) } }).range(pos, end))
            if (h.ins) d.push(Decoration.widget({ widget: new InsWidget(h.ins, 'pending' + focused, i), side: 1 }).range(end))
          }
          pos = end
        })
      }
      block(help.at, new ControlsWidget(help))
      break
  }
  return Decoration.set(d, true)
}

// ---- Widgets --------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag)
  // Help controls are driven from the keyboard shortcuts, so keep them out of the tab order.
  if (tag === 'button') e.tabIndex = -1
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function kbd(text: string) {
  return el('kbd', undefined, text)
}

class LineWidget extends WidgetType {
  constructor(readonly label: string, readonly text: string, readonly tone: 'loading' | 'notice' | 'error' | 'hint') {
    super()
  }
  eq(o: LineWidget) {
    return o.label === this.label && o.text === this.text && o.tone === this.tone
  }
  toDOM() {
    const wrap = el('div', `hl-line hl-${this.tone}`)
    if (this.label) wrap.append(el('span', 'hl-label', this.label))
    if (this.tone === 'error') wrap.append(el('span', 'hl-glyph', '!'))
    if (this.text) wrap.append(el('span', 'hl-text', this.text))
    if (this.tone === 'loading') wrap.append(el('div', 'hl-progress'))
    return wrap
  }
}

class RecallWidget extends WidgetType {
  constructor(readonly help: Extract<Help, { kind: 'recall' }>) {
    super()
  }
  eq(o: RecallWidget) {
    return o.help.results === this.help.results && o.help.sel === this.help.sel && o.help.page === this.help.page
  }
  toDOM() {
    const { results, page, sel } = this.help
    const card = el('div', 'hl-card hl-recall')
    const head = el('div', 'hl-card-head')
    head.append(el('span', 'hl-label', levelLabel(1)), el('span', 'hl-meta', `${results.length} of your sources`))
    card.append(head)
    results.slice(page * 3, page * 3 + 3).forEach((r, k) => {
      const i = page * 3 + k
      const row = el('div', 'hl-result' + (i === sel ? ' is-sel' : ''))
      row.append(el('div', 'hl-excerpt', `“${excerpt(r.text)}”`))
      const chip = el('button', 'chip', `↳ ${r.folder ? r.folder + ' / ' : ''}${r.title}`)
      chip.title = 'Open the source'
      chip.onclick = (e) => {
        e.preventDefault()
        hooks?.openSource(r.doc)
      }
      row.append(chip)
      row.onmousedown = (e) => {
        if ((e.target as HTMLElement).closest('.chip')) return
        e.preventDefault()
        hooks?.insertRecall(i)
      }
      card.append(row)
    })
    const foot = el('div', 'hl-card-foot')
    const left = el('span')
    left.append(kbd('⌘↵'), ' insert quote · ', kbd('↑↓'), ' choose · ', kbd('Esc'))
    const more = el('span', undefined, results.length > (page + 1) * 3 ? `${helpMod}1 more` : '')
    foot.append(left, more)
    card.append(foot)
    return card
  }
  ignoreEvent() {
    return true
  }
}

function excerpt(t: string) {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > 240 ? s.slice(0, 237).replace(/\s+\S*$/, '') + '…' : s
}

class NudgeWidget extends WidgetType {
  constructor(readonly text: string, readonly inMargin: boolean) {
    super()
  }
  eq(o: NudgeWidget) {
    return o.text === this.text && o.inMargin === this.inMargin
  }
  toDOM() {
    const anchor = el(this.inMargin ? 'span' : 'div', this.inMargin ? 'hl-nudge-anchor' : 'hl-nudge-below')
    const note = el('span', 'hl-nudge')
    note.append(el('span', 'hl-label', levelLabel(2)), el('span', 'hl-question', this.text))
    const acts = el('span', 'hl-actions')
    const resolve = el('button', 'hl-link', 'Resolve')
    resolve.onmousedown = (e) => {
      e.preventDefault()
      hooks?.resolveNudge()
    }
    acts.append(resolve, ` ⌘↵ · ${helpMod}2 another · Esc`)
    note.append(acts)
    anchor.append(note)
    return anchor
  }
  ignoreEvent() {
    return true
  }
}

class WordWidget extends WidgetType {
  constructor(readonly help: Extract<Help, { kind: 'word' }>) {
    super()
  }
  eq(o: WordWidget) {
    return o.help.options === this.help.options && o.help.sel === this.help.sel && o.help.from === this.help.from
  }
  toDOM(view: EditorView) {
    const wrap = el('div', 'hl-word-wrap')
    const list = el('div', 'hl-card hl-word')
    const head = el('div', 'hl-card-head')
    head.append(el('span', 'hl-label', levelLabel(3)), el('span', 'hl-meta', this.help.mode === 'next' ? 'next word' : 'replace'))
    list.append(head)
    this.help.options.forEach((o, i) => {
      const row = el('div', 'hl-option' + (i === this.help.sel ? ' is-sel' : ''))
      row.append(el('span', undefined, o), el('span', 'hl-key', i === this.help.sel ? '↵' : String(i + 1)))
      row.onmousedown = (e) => {
        e.preventDefault()
        hooks?.pickWord(i)
      }
      list.append(row)
    })
    const foot = el('div', 'hl-card-foot')
    const hints = el('span')
    hints.append(kbd('↑↓'), ' choose · ', kbd('↵'), ' pick · ', kbd('Esc'))
    foot.append(hints, el('span', undefined, `${helpMod}3 more`))
    list.append(foot)
    wrap.append(list)
    // Line the list up under the word once layout is known, never past the column's edge.
    const from = this.help.from
    view.requestMeasure({
      read: (v) => {
        const word = v.coordsAtPos(from, 1)
        const content = v.contentDOM.getBoundingClientRect()
        return { left: word ? word.left - content.left : 0, width: v.contentDOM.clientWidth }
      },
      write: ({ left, width }) => {
        const max = Math.max(0, width - list.offsetWidth)
        list.style.marginLeft = `${Math.round(Math.min(Math.max(0, left - 10), max))}px`
      },
    })
    return wrap
  }
  ignoreEvent() {
    return true
  }
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(o: GhostWidget) {
    return o.text === this.text
  }
  toDOM() {
    return el('span', 'hl-ghost', this.text)
  }
}

class BarWidget extends WidgetType {
  constructor(readonly busy: boolean) {
    super()
  }
  // Keep one DOM node for the bar's whole life so the field keeps its focus and text.
  eq() {
    return true
  }
  updateDOM(dom: HTMLElement) {
    dom.classList.toggle('is-busy', this.busy)
    return true
  }
  toDOM(view: EditorView) {
    const bar = el('div', 'hl-bar' + (this.busy ? ' is-busy' : ''))
    const help = view.state.field(helpField)
    bar.append(el('span', 'hl-label', levelLabel(help?.level === 4 ? 4 : 5)))
    const input = el('input', 'hl-input')
    input.placeholder = 'How should this change?'
    input.value = help?.kind === 'diff' ? help.instruction : lastInstruction
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        if (input.value.trim()) {
          lastInstruction = input.value.trim()
          hooks?.runInstruction(input.value.trim())
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        hooks?.dismiss()
        view.focus()
      } else if (e.key === 'Tab' && view.state.field(helpField)?.kind === 'diff') {
        e.preventDefault()
        view.focus()
        hooks?.stepHunk(e.shiftKey ? -1 : 1)
      } else if (e.key === 'ArrowUp' && !input.value) {
        input.value = lastInstruction
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 'Backspace') && view.state.field(helpField)?.kind === 'diff') {
        e.preventDefault()
        if (e.key === 'Enter') hooks?.acceptAll()
        else hooks?.rejectAll()
        view.focus()
      }
      e.stopPropagation()
    }
    const hint = el('span', 'hl-meta', help?.kind === 'diff' ? '↵ refine · Esc' : '↵ run · Esc')
    bar.append(input, hint, el('div', 'hl-progress'))
    if (help?.kind === 'bar') requestAnimationFrame(() => input.focus())
    return bar
  }
  ignoreEvent() {
    return true
  }
}
let lastInstruction = ''

class InsWidget extends WidgetType {
  constructor(readonly text: string, readonly state: string, readonly index: number) {
    super()
  }
  eq(o: InsWidget) {
    return o.text === this.text && o.state === this.state
  }
  toDOM() {
    const span = el('span', `cm-ins is-${this.state.split(' ')[0]}${this.state.includes('is-focus') ? ' is-focus' : ''}`, this.text)
    if (this.state.includes('is-focus')) {
      const marks = el('span', 'hl-marks')
      const yes = el('button', 'hl-yes', '✓')
      const no = el('button', 'hl-no', '✕')
      yes.onmousedown = (e) => {
        e.preventDefault()
        hooks?.decideHunk(this.index, 'accepted')
      }
      no.onmousedown = (e) => {
        e.preventDefault()
        hooks?.decideHunk(this.index, 'rejected')
      }
      marks.append(yes, no)
      span.append(marks)
    }
    return span
  }
  ignoreEvent() {
    return true
  }
}

class SideBySideWidget extends WidgetType {
  constructor(readonly help: Extract<Help, { kind: 'diff' }>) {
    super()
  }
  eq(o: SideBySideWidget) {
    return o.help.hunks === this.help.hunks
  }
  toDOM() {
    const grid = el('div', 'hl-sbs')
    const left = el('div', 'hl-sbs-col')
    const right = el('div', 'hl-sbs-col')
    left.append(el('div', 'hl-colhead', 'Original'))
    right.append(el('div', 'hl-colhead', 'Suggestion'))
    const lt = el('div', 'hl-sbs-text is-original')
    const rt = el('div', 'hl-sbs-text')
    for (const h of this.help.hunks) {
      if (h.kind === 'eq') {
        lt.append(h.text)
        rt.append(h.text)
      } else {
        if (h.del) lt.append(el('del', undefined, h.del))
        if (h.ins) rt.append(el('ins', undefined, h.ins))
      }
    }
    left.append(lt)
    right.append(rt)
    grid.append(left, right)
    return grid
  }
  ignoreEvent() {
    return true
  }
}

class ControlsWidget extends WidgetType {
  constructor(readonly help: Extract<Help, { kind: 'diff' }>) {
    super()
  }
  eq(o: ControlsWidget) {
    return o.help.hunks === this.help.hunks && o.help.focus === this.help.focus
  }
  toDOM() {
    const changes = this.help.hunks.filter((h) => h.kind === 'chg')
    const decided = changes.filter((h) => h.kind === 'chg' && h.state !== 'pending').length
    const row = el('div', 'hl-controls')
    const acc = el('button', 'hl-link is-strong')
    acc.append(kbd('⌘↵'), ' Accept all')
    acc.onmousedown = (e) => {
      e.preventDefault()
      hooks?.acceptAll()
    }
    const rej = el('button', 'hl-link')
    rej.append(kbd('⌘⌫'), ' Reject all')
    rej.onmousedown = (e) => {
      e.preventDefault()
      hooks?.rejectAll()
    }
    const count = decided ? `${decided} of ${changes.length} decided` : `${changes.length} change${changes.length === 1 ? '' : 's'}`
    row.append(acc, el('span', 'hl-sep', '·'), rej, el('span', 'hl-sep', '·'), el('span', undefined, count))
    if (!this.help.sideBySide) {
      const step = el('span')
      step.append(el('span', 'hl-sep', '·'), kbd('Tab'), ' step through · ', kbd('↵'), ' accept · ', kbd('⌫'), ' reject')
      row.append(step)
    } else {
      row.append(el('span', 'hl-sep', '·'), el('span', 'hl-meta', 'Most of this passage changed, so it’s shown side by side.'))
    }
    return row
  }
  ignoreEvent() {
    return true
  }
}

class DotWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const dot = el('span', 'hl-dot')
    dot.title = `Recall has something from your notes (${helpMod}1)`
    dot.onmousedown = (e) => {
      e.preventDefault()
      hooks?.recallAtDot()
    }
    return dot
  }
  ignoreEvent() {
    return true
  }
}

// ---- Diff helpers ---------------------------------------------------------------------------

/** Word-level diff, computed by code, grouped into equal runs and changes. */
export function computeHunks(original: string, suggestion: string): Hunk[] {
  const merged: Hunk[] = []
  for (const p of diffWordsWithSpace(original, suggestion)) {
    const last = merged[merged.length - 1]
    if (!p.added && !p.removed) {
      // A lone space between two changes belongs to them, so "a b" → "c d" reads as one change.
      if (/^\s+$/.test(p.value) && last?.kind === 'chg') {
        last.del += p.value
        last.ins += p.value
      } else merged.push({ kind: 'eq', text: p.value })
    } else if (last?.kind === 'chg') {
      if (p.removed) last.del += p.value
      else last.ins += p.value
    } else {
      merged.push({ kind: 'chg', del: p.removed ? p.value : '', ins: p.added ? p.value : '', state: 'pending' })
    }
  }
  // Whitespace that ends both sides of a change is really unchanged text: move it back out.
  const out: Hunk[] = []
  for (const h of merged) {
    if (h.kind === 'eq') {
      const prev = out[out.length - 1]
      if (prev?.kind === 'eq') prev.text += h.text
      else out.push(h)
      continue
    }
    const tail = commonTrailingSpace(h.del, h.ins)
    if (tail) {
      h.del = h.del.slice(0, -tail.length)
      h.ins = h.ins.slice(0, -tail.length)
    }
    if (h.del || h.ins) out.push(h)
    if (tail) out.push({ kind: 'eq', text: tail })
  }
  return out
}

function commonTrailingSpace(a: string, b: string) {
  let n = 0
  while (n < a.length && n < b.length && /\s/.test(a[a.length - 1 - n]) && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n ? a.slice(a.length - n) : ''
}

/** The text that results from the decisions so far; pending changes resolve to `pending`. */
export function resolveHunks(hunks: Hunk[], pending: 'accepted' | 'rejected') {
  return hunks
    .map((h) => (h.kind === 'eq' ? h.text : (h.state === 'pending' ? pending : h.state) === 'accepted' ? h.ins : h.del))
    .join('')
}

export function changedRatio(original: string, hunks: Hunk[]) {
  const changedWords = hunks
    .filter((h): h is Hunk & { kind: 'chg' } => h.kind === 'chg')
    .reduce((n, h) => n + h.del.split(/\s+/).filter(Boolean).length, 0)
  const total = original.split(/\s+/).filter(Boolean).length || 1
  return changedWords / total
}

// ---- Scope helpers --------------------------------------------------------------------------

/** The paragraph around `pos`: contiguous non-blank lines. */
export function paragraphAt(state: EditorState, pos: number) {
  const doc = state.doc
  let first = doc.lineAt(pos)
  let last = first
  if (!first.text.trim()) return { from: first.from, to: first.to }
  while (first.number > 1) {
    const prev = doc.line(first.number - 1)
    if (!prev.text.trim()) break
    first = prev
  }
  while (last.number < doc.lines) {
    const next = doc.line(last.number + 1)
    if (!next.text.trim()) break
    last = next
  }
  return { from: first.from, to: last.to }
}

export function sentenceAround(text: string, offset: number) {
  const before = text.slice(0, offset)
  const start = Math.max(before.search(/[^.!?]*$/), 0)
  const rest = text.slice(offset)
  const endRel = rest.search(/[.!?](\s|$)/)
  const end = endRel < 0 ? text.length : offset + endRel + 1
  return text.slice(start, end).trim()
}
