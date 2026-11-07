// The help ladder on the page. Suggestions live in plugin state and are drawn as decorations, so the
// writer's text is never touched until they accept something.
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { diffWordsWithSpace } from 'diff'
import { EDGE_NAMES, fromLine, type EdgeCandidate, type EdgeSlot } from '../lib/edge.ts'

export type Level = 1 | 2 | 3 | 4 | 5

export interface RecallResult {
  doc: string
  title: string
  folder: string
  text: string
  score: number
  /** A highlight from the Brain: the kind of source ('book', 'video'…) and where in it. */
  sourceType?: string
  location?: string
}

/** A result's chip: "Book · Title · loc 1234" for a Brain highlight, "folder / Title" for the writer's own page. */
export function sourceLabel(r: RecallResult): string {
  if (!r.sourceType) return `${r.folder ? r.folder + ' / ' : ''}${r.title}`
  const type = r.sourceType.charAt(0).toUpperCase() + r.sourceType.slice(1)
  return [type, r.title, r.location].filter(Boolean).join(' · ')
}

export type Hunk = { kind: 'eq'; text: string } | { kind: 'chg'; del: string; ins: string; state: 'pending' | 'accepted' | 'rejected' }

// Positions are document positions. `at` is where a card goes: just after the block the help is about.
export type Help =
  // `caret`: the request is about the caret here (a next word, a ghost, opening questions). Typing or
  // moving the caret cancels it, so an answer never lands where the writer no longer is.
  | { kind: 'loading'; level: Level; from: number; to: number; at: number; slow?: boolean; label?: string; caret?: number }
  | { kind: 'notice'; level?: Level; from: number; to: number; at: number; text: string; tone?: 'error'; label?: string }
  | { kind: 'recall'; level: 1; from: number; to: number; at: number; results: RecallResult[]; page: number; sel: number }
  | { kind: 'nudge'; level: 2; from: number; to: number; at: number; text: string; history: string[]; inMargin: boolean }
  // 'complete' finishes the word the caret is in: from–to is the whole word, replaced on accepting.
  | { kind: 'word'; level: 3; mode: 'replace' | 'next' | 'complete'; from: number; to: number; at: number; options: string[]; sel: number; seen: string[] }
  | {
      kind: 'ghost'
      level: 4 | 5
      from: number
      to: number // where the key hint goes
      at: number // where the text goes
      caret: number // moving the caret away from here dismisses it
      text: string
      seen: string[]
      /** What Tab accepts: all of it (⌘4), or the next sentence (⌘5). */
      unit: 'all' | 'sentence'
      /** Text that goes in a new block after the caret's: a paragraph (after a heading) or a list item. */
      block?: 'paragraph' | 'listItem' | 'taskItem'
      /** What the writer has accepted of it so far. */
      taken: string
    }
  /** Questions to find a first line in, before the writer has written one. Never prose. */
  | { kind: 'questions'; level: Level; from: number; to: number; at: number; questions: string[]; seen: string[] }
  // A subject, title, excerpt or opening line drawn from the draft. Its card sits at the top of the page.
  | { kind: 'edge'; level: 3; slot: EdgeSlot; from: number; to: number; at: number; options: EdgeCandidate[]; sel: number; seen: string[]; note?: string }
  | { kind: 'bar'; level: 4 | 5; from: number; to: number; busy: boolean; hint?: boolean }
  | {
      kind: 'diff'
      level: 3 | 4 | 5 // 3: an opening line proposed in place
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

interface HelpState {
  help: Help | null
  /** Where the Recall dot sits, if anywhere. */
  dot: number | null
}

/** A change to help, sent as transaction metadata. A transaction that sets `help` is help's own. */
export interface HelpMeta {
  help?: Help | null
  dot?: number | null
}

export const helpKey = new PluginKey<HelpState>('help')

export const helpOf = (state: EditorState) => helpKey.getState(state)?.help ?? null
export const dotOf = (state: EditorState) => helpKey.getState(state)?.dot ?? null
export const setHelp = (tr: Transaction, help: Help | null) => tr.setMeta(helpKey, { help } satisfies HelpMeta)

function mapHelp(help: Help, tr: Transaction): Help | null {
  const m = (pos: number, assoc = 1) => tr.mapping.map(pos, assoc)
  // Typing wins: any edit dismisses the suggestion. A Nudge covers nothing, so it stays.
  if (help.kind === 'nudge' || help.kind === 'questions') return { ...help, from: m(help.from, -1), to: m(help.to), at: m(help.at) }
  if (help.kind === 'bar') return { ...help, from: m(help.from, -1), to: m(help.to) }
  // Recall and a Nudge only read the text, so their answer follows it; anything that would write
  // at the caret or over a selection is cancelled by the edit (the controller drops the answer).
  if (help.kind === 'loading' && help.caret === undefined && (help.level === 1 || help.level === 2)) return { ...help, from: m(help.from, -1), to: m(help.to), at: m(help.at) }
  return null
}

export function helpPlugin() {
  return new Plugin<HelpState>({
    key: helpKey,
    state: {
      init: () => ({ help: null, dot: null }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(helpKey) as HelpMeta | undefined
        let { help, dot } = value
        if (meta && 'help' in meta) help = meta.help ?? null
        else if (help && tr.docChanged) help = mapHelp(help, tr)
        else if (help && tr.selectionSet && (help.kind === 'ghost' || help.kind === 'word' || (help.kind === 'loading' && help.caret !== undefined))) {
          // Moving away from a word list or ghost text dismisses it, and cancels one still being asked for.
          const head = state.selection.head
          if ((help.kind === 'ghost' || help.kind === 'loading') && (head !== help.caret || !state.selection.empty)) help = null
          else if (help.kind === 'word' && (head < help.from || head > help.to)) help = null
        }
        if (meta && 'dot' in meta) dot = meta.dot ?? null
        else if (dot !== null && tr.docChanged) dot = tr.mapping.map(dot, -1)
        return { help, dot }
      },
    },
    props: {
      decorations(state) {
        const s = helpKey.getState(state)
        if (!s) return null
        const d: Decoration[] = []
        if (s.help) buildDecorations(state.doc, s.help, d)
        if (s.dot !== null && s.dot <= state.doc.content.size) d.push(Decoration.widget(s.dot, dotWidget, { side: -1, key: 'dot', ...inert }))
        return d.length ? DecorationSet.create(state.doc, d) : null
      },
    },
    // The instruction bar is drawn once and kept; only its busy state changes.
    view: () => ({
      update(view) {
        const h = helpOf(view.state)
        view.dom.parentElement?.querySelector('.hl-bar')?.classList.toggle('is-busy', h?.kind === 'bar' && h.busy)
      },
    }),
  })
}

// ---- Hooks the widgets call back into (set by the controller) ------------------------------

export interface WidgetHooks {
  runInstruction(text: string): void
  dismiss(): void
  pickWord(index: number): void
  pickEdge(index: number): void
  moreEdge(): void
  insertRecall(index: number): void
  openSource(doc: string): void
  resolveNudge(): void
  decideHunk(index: number, state: 'accepted' | 'rejected'): void
  acceptAll(): void
  rejectAll(): void
  recallAtDot(): void
  stepHunk(delta: number): void
  focusEditor(): void
  current(): Help | null
}

let hooks: WidgetHooks | null = null
export function setWidgetHooks(h: WidgetHooks) {
  hooks = h
}

export const helpShowing = () => !!hooks?.current()

/** Dismiss the help showing on the page, from outside the editor (the panel, a card's buttons). False if none is showing. */
export function dismissHelp() {
  if (!helpShowing()) return false
  hooks?.dismiss()
  return true
}

// ---- Labels -------------------------------------------------------------------------------

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
/** Edge lines from ⌘3 in the title carry the key; those asked for beside a field are named for it. */
export const edgeLabel = (slot: EdgeSlot) => (slot === 'title' || slot === 'opening' ? `${helpMod}3 · ${EDGE_NAMES[slot]}` : EDGE_NAMES[slot])

// ---- Decorations ----------------------------------------------------------------------------

// Help widgets are controls, not text: the editor leaves their clicks and selection alone.
const inert = { stopEvent: () => true, ignoreSelection: true }

function buildDecorations(doc: PMNode, help: Help, d: Decoration[]) {
  const size = doc.content.size
  const clamp = (p: number) => Math.max(0, Math.min(size, p))
  const scope = (from: number, to: number, cls = 'cm-scope') => {
    if (to > from) d.push(Decoration.inline(clamp(from), clamp(to), { class: cls }))
  }
  // Drawn plain: a suggestion beside bold text isn't bold unless accepting it would make it so.
  const card = (at: number, key: string, make: () => HTMLElement, side = 1) => d.push(Decoration.widget(clamp(at), make, { side, key, marks: [], ...inert }))

  switch (help.kind) {
    case 'loading':
      scope(help.from, help.to)
      card(help.at, `loading-${help.level}-${help.slow}-${help.label}`, () => lineWidget(help.label ?? levelLabel(help.level), help.slow ? 'Still working · Esc to cancel' : '', 'loading'))
      break
    case 'notice':
      if (help.level) scope(help.from, help.to)
      card(help.at, `notice-${help.text}`, () => lineWidget(help.label ?? (help.level ? levelLabel(help.level) : ''), help.text, help.tone === 'error' ? 'error' : 'notice'))
      break
    case 'recall':
      scope(help.from, help.to)
      card(help.at, `recall-${help.page}-${help.sel}-${help.results.length}`, () => recallWidget(help))
      break
    case 'nudge':
      scope(help.from, help.to)
      // In the margin when there's room beside the column; otherwise a quiet line under the paragraph.
      if (help.inMargin) card(help.from, `nudge-m-${help.text}`, () => nudgeWidget(help.text, true), -1)
      else card(help.at, `nudge-${help.text}`, () => nudgeWidget(help.text, false))
      break
    case 'word':
      scope(help.from, help.to, 'cm-scope cm-scope-word')
      card(help.at, `word-${help.options.join('|')}-${help.sel}`, () => wordWidget(help))
      break
    case 'edge':
      scope(help.from, help.to)
      card(help.at, `edge-${help.slot}-${help.options.map((o) => o.text).join('|')}-${help.sel}-${help.note ?? ''}`, () => edgeWidget(help), -1)
      break
    case 'ghost': {
      const hint = help.unit === 'sentence' ? `Tab next sentence · ⌥→ one word · ⌘↵ all · ${helpMod}${help.level} another · Esc` : `Tab accept · ⌥→ one word · ${helpMod}${help.level} another · Esc`
      if (help.block) {
        // A new paragraph or list item, shown where it would go: after the caret's block.
        card(help.at, `ghost-block-${help.block}-${help.text}`, () => ghostBlockWidget(help.block!, help.text, levelLabel(help.level), hint), -1)
      } else {
        card(help.at, `ghost-${help.text}`, () => el('span', 'hl-ghost', help.text), 1)
        card(help.to, `ghost-hint-${help.level}-${help.text}`, () => ghostHint(levelLabel(help.level), hint, help.text))
      }
      break
    }
    case 'questions':
      card(help.at, `questions-${help.questions.join('|')}`, () => questionsWidget(help))
      break
    case 'bar':
      scope(help.from, help.to)
      card(help.from, 'bar', () => barWidget(), -1)
      break
    case 'diff': {
      if (help.bar) card(help.from, 'bar', () => barWidget(), -1)
      const map = textMap(doc, help.from, help.to)
      if (help.sideBySide) {
        // The passage is shown as two columns instead of in place.
        doc.nodesBetween(help.from, help.to, (node, pos) => {
          if (!node.isTextblock) return true
          d.push(Decoration.node(pos, pos + node.nodeSize, { class: 'hl-hidden' }))
          return false
        })
        card(help.at, `sbs-${help.hunks.length}`, () => sideBySideWidget(help))
      } else {
        let offset = 0
        help.hunks.forEach((h, i) => {
          if (h.kind === 'eq') {
            offset += h.text.length
            return
          }
          const from = map.pos(offset)
          const to = map.pos(offset + h.del.length)
          const focused = i === help.focus
          if (h.state === 'accepted') {
            if (to > from) d.push(Decoration.inline(from, to, { class: 'hl-hidden-text' }))
            card(to, `ins-${i}-a`, () => insWidget(h.ins, 'accepted', i, false), 1)
          } else if (h.state === 'pending') {
            if (to > from) d.push(Decoration.inline(from, to, { class: 'cm-del' + (focused ? ' is-focus' : ''), 'data-hunk': String(i) }))
            if (h.ins) card(to, `ins-${i}-${focused}`, () => insWidget(h.ins, 'pending', i, focused), 1)
          }
          offset += h.del.length
        })
      }
      const changes = help.hunks.filter((h) => h.kind === 'chg')
      const decided = changes.filter((h) => h.kind === 'chg' && h.state !== 'pending').length
      card(help.at, `controls-${decided}-${help.focus}`, () => controlsWidget(help))
      break
    }
  }
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

const kbd = (text: string) => el('kbd', undefined, text)
const press = (fn: () => void) => (e: MouseEvent) => {
  e.preventDefault()
  fn()
}

function lineWidget(label: string, text: string, tone: 'loading' | 'notice' | 'error' | 'hint') {
  const wrap = el('div', `hl-line hl-${tone}`)
  if (label) wrap.append(el('span', 'hl-label', label))
  if (tone === 'error') wrap.append(el('span', 'hl-glyph', '!'))
  if (text) wrap.append(el('span', 'hl-text', text))
  if (tone === 'loading') wrap.append(el('div', 'hl-progress'))
  return wrap
}

function recallWidget(help: Extract<Help, { kind: 'recall' }>) {
  const { results, page, sel } = help
  const card = el('div', 'hl-card hl-recall')
  const head = el('div', 'hl-card-head')
  head.append(el('span', 'hl-label', levelLabel(1)), el('span', 'hl-meta', `${results.length} of your sources`))
  card.append(head)
  results.slice(page * 3, page * 3 + 3).forEach((r, k) => {
    const i = page * 3 + k
    const row = el('div', 'hl-result' + (i === sel ? ' is-sel' : ''))
    row.append(el('div', 'hl-excerpt', `“${excerpt(r.text)}”`))
    const chip = el('button', 'chip' + (r.sourceType ? ' is-source' : ''), `↳ ${sourceLabel(r)}`)
    chip.title = r.sourceType ? 'Open the note in your Brain' : 'Open the source'
    chip.onmousedown = press(() => hooks?.openSource(r.doc))
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
  foot.append(left, el('span', undefined, results.length > (page + 1) * 3 ? `${helpMod}1 more` : ''))
  card.append(foot)
  return card
}

function excerpt(t: string) {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > 240 ? s.slice(0, 237).replace(/\s+\S*$/, '') + '…' : s
}

function ghostBlockWidget(block: 'paragraph' | 'listItem' | 'taskItem', text: string, label: string, hint: string) {
  const wrap = el(block === 'paragraph' ? 'div' : 'li', `hl-ghost-block is-${block}`)
  wrap.append(el('p', 'hl-ghost', text.trimStart()), ghostHint(label, hint, text))
  return wrap
}

/** The keys under ghost text. A screen reader hears the suggestion itself too, since grey text is silent. */
function ghostHint(label: string, hint: string, text: string) {
  const line = lineWidget(label, hint, 'hint')
  line.setAttribute('role', 'status')
  line.prepend(el('span', 'hl-sr', `Suggested: ${text.trim()}`))
  return line
}

function questionsWidget(help: Extract<Help, { kind: 'questions' }>) {
  const card = el('div', 'hl-card hl-questions')
  card.setAttribute('role', 'status')
  const head = el('div', 'hl-card-head')
  head.append(el('span', 'hl-label', levelLabel(help.level)), el('span', 'hl-meta', 'questions to start from'))
  card.append(head, el('div', 'hl-questions-lead', 'Write your first line — then I can continue from your words'))
  const list = el('ul', 'hl-question-list')
  for (const q of help.questions) list.append(el('li', undefined, q))
  card.append(list)
  const foot = el('div', 'hl-card-foot')
  const left = el('span')
  left.append(kbd('Esc'), ' dismiss')
  foot.append(left, el('span', undefined, `${helpMod}${help.level} other questions`))
  card.append(foot)
  return card
}

function nudgeWidget(text: string, inMargin: boolean) {
  const anchor = el(inMargin ? 'span' : 'div', inMargin ? 'hl-nudge-anchor' : 'hl-nudge-below')
  const note = el('span', 'hl-nudge')
  note.append(el('span', 'hl-label', levelLabel(2)), el('span', 'hl-question', text))
  const acts = el('span', 'hl-actions')
  const resolve = el('button', 'hl-link', 'Resolve')
  resolve.onmousedown = press(() => hooks?.resolveNudge())
  acts.append(resolve, ` ⌘↵ · ${helpMod}2 another · Esc`)
  note.append(acts)
  anchor.append(note)
  return anchor
}

function wordWidget(help: Extract<Help, { kind: 'word' }>) {
  const wrap = el('div', 'hl-word-wrap')
  const list = el('div', 'hl-card hl-word')
  const head = el('div', 'hl-card-head')
  head.append(el('span', 'hl-label', levelLabel(3)), el('span', 'hl-meta', help.mode === 'next' ? 'next word' : help.mode === 'complete' ? 'finish the word' : 'replace'))
  list.append(head)
  help.options.forEach((o, i) => {
    const row = el('div', 'hl-option' + (i === help.sel ? ' is-sel' : ''))
    row.append(el('span', undefined, o), el('span', 'hl-key', i === help.sel ? '↵' : String(i + 1)))
    row.onmousedown = press(() => hooks?.pickWord(i))
    list.append(row)
  })
  const foot = el('div', 'hl-card-foot')
  const hints = el('span')
  hints.append(kbd('↑↓'), ' choose · ', kbd('↵'), ' pick · ', kbd('Esc'))
  foot.append(hints, el('span', undefined, `${helpMod}3 more`))
  list.append(foot)
  wrap.append(list)
  // Line the list up under the word once it's on the page, never past the column's edge.
  requestAnimationFrame(() => {
    const word = document.querySelector('.cm-scope-word')?.getBoundingClientRect()
    const column = wrap.parentElement?.getBoundingClientRect()
    if (!word || !column) return
    const max = Math.max(0, column.width - list.offsetWidth)
    list.style.marginLeft = `${Math.round(Math.min(Math.max(0, word.left - column.left - 10), max))}px`
  })
  return wrap
}

/** Edge lines: each candidate with the sentence of the draft it came from. */
function edgeWidget(help: Extract<Help, { kind: 'edge' }>) {
  const list = el('div', 'hl-card hl-edge')
  const head = el('div', 'hl-card-head')
  head.append(el('span', 'hl-label', edgeLabel(help.slot)), el('span', 'hl-meta', 'drawn from your draft'))
  list.append(head)
  help.options.forEach((o, i) => {
    const row = el('div', 'hl-option hl-edge-option' + (i === help.sel ? ' is-sel' : ''))
    const text = el('div', 'hl-edge-text')
    text.append(el('span', undefined, o.text), el('span', 'hl-key', i === help.sel ? '↵' : String(i + 1)))
    row.append(text, el('div', 'hl-edge-from', `from: ${fromLine(o.source)}`))
    row.title = o.source
    row.onmousedown = press(() => hooks?.pickEdge(i))
    list.append(row)
  })
  const foot = el('div', 'hl-card-foot')
  const hints = el('span')
  hints.append(kbd('↑↓'), ' choose · ', kbd('↵'), ' use · ', kbd('Esc'))
  // Once the draft has no more lines to offer, say so where 'more' was and keep these to choose from.
  if (help.note) foot.append(hints, el('span', 'hl-meta', help.note))
  else {
    const more = el('button', 'hl-link', help.slot === 'title' || help.slot === 'opening' ? `${helpMod}3 more` : 'More')
    more.onmousedown = press(() => hooks?.moreEdge())
    foot.append(hints, more)
  }
  list.append(foot)
  return list
}

let lastInstruction = ''

function barWidget() {
  const help = hooks?.current()
  const bar = el('div', 'hl-bar' + (help?.kind === 'bar' && help.busy ? ' is-busy' : ''))
  bar.append(el('span', 'hl-label', levelLabel(help && 'level' in help && help.level === 4 ? 4 : 5)))
  const input = el('input', 'hl-input')
  input.placeholder = 'How should this change?'
  input.value = help?.kind === 'diff' ? help.instruction : lastInstruction
  input.onkeydown = (e) => {
    const h = hooks?.current()
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      if (input.value.trim()) {
        lastInstruction = input.value.trim()
        hooks?.runInstruction(input.value.trim())
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      hooks?.dismiss()
      hooks?.focusEditor()
    } else if (e.key === 'Tab' && h?.kind === 'diff') {
      e.preventDefault()
      hooks?.focusEditor()
      hooks?.stepHunk(e.shiftKey ? -1 : 1)
    } else if (e.key === 'ArrowUp' && !input.value) {
      input.value = lastInstruction
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 'Backspace') && h?.kind === 'diff') {
      e.preventDefault()
      if (e.key === 'Enter') hooks?.acceptAll()
      else hooks?.rejectAll()
      hooks?.focusEditor()
    }
    e.stopPropagation()
  }
  bar.append(input, el('span', 'hl-meta', help?.kind === 'diff' ? '↵ refine · Esc' : '↵ run · Esc'), el('div', 'hl-progress'))
  if (help?.kind === 'bar' && help.hint) bar.append(el('div', 'hl-bar-hint', `At the end of a paragraph, ${helpMod}5 continues it`))
  if (help?.kind === 'bar') requestAnimationFrame(() => input.focus())
  return bar
}

function insWidget(text: string, state: 'pending' | 'accepted', index: number, focused: boolean) {
  // A proposed paragraph break shows as one, not as a space (an opening line goes in as its own paragraph).
  const span = el('span', `cm-ins is-${state}${focused ? ' is-focus' : ''}${text.includes('\n') ? ' has-break' : ''}`, text)
  if (focused) {
    const marks = el('span', 'hl-marks')
    const yes = el('button', 'hl-yes', '✓')
    const no = el('button', 'hl-no', '✕')
    yes.onmousedown = press(() => hooks?.decideHunk(index, 'accepted'))
    no.onmousedown = press(() => hooks?.decideHunk(index, 'rejected'))
    marks.append(yes, no)
    span.append(marks)
  }
  return span
}

function sideBySideWidget(help: Extract<Help, { kind: 'diff' }>) {
  const grid = el('div', 'hl-sbs')
  const left = el('div', 'hl-sbs-col')
  const right = el('div', 'hl-sbs-col')
  left.append(el('div', 'hl-colhead', 'Original'))
  right.append(el('div', 'hl-colhead', 'Suggestion'))
  const lt = el('div', 'hl-sbs-text is-original')
  const rt = el('div', 'hl-sbs-text')
  for (const h of help.hunks) {
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

function controlsWidget(help: Extract<Help, { kind: 'diff' }>) {
  const changes = help.hunks.filter((h) => h.kind === 'chg')
  const decided = changes.filter((h) => h.kind === 'chg' && h.state !== 'pending').length
  const row = el('div', 'hl-controls')
  const acc = el('button', 'hl-link is-strong')
  acc.append(kbd('⌘↵'), ' Accept all')
  acc.onmousedown = press(() => hooks?.acceptAll())
  const rej = el('button', 'hl-link')
  rej.append(kbd('⌘⌫'), ' Reject all')
  rej.onmousedown = press(() => hooks?.rejectAll())
  const count = decided ? `${decided} of ${changes.length} decided` : `${changes.length} change${changes.length === 1 ? '' : 's'}`
  row.append(acc, el('span', 'hl-sep', '·'), rej, el('span', 'hl-sep', '·'), el('span', undefined, count))
  if (!help.sideBySide) {
    const step = el('span')
    step.append(el('span', 'hl-sep', '·'), kbd('Tab'), ' step through · ', kbd('↵'), ' accept · ', kbd('⌫'), ' reject')
    row.append(step)
  } else {
    row.append(el('span', 'hl-sep', '·'), el('span', 'hl-meta', 'Most of this passage changed, so it’s shown side by side.'))
  }
  return row
}

function dotWidget() {
  const dot = el('span', 'hl-dot')
  dot.title = `Recall has something from your notes (${helpMod}1)`
  dot.onmousedown = press(() => hooks?.recallAtDot())
  return dot
}

// ---- Text and positions ---------------------------------------------------------------------

/** How an inline leaf reads as text: a page link as its title, a line break as a newline. */
export function leafText(node: PMNode) {
  if (node.type.name === 'hardBreak') return '\n'
  if (node.type.name === 'pageLink') return node.attrs.label || node.attrs.target
  if (node.type.name === 'rawInline') return node.attrs.text
  return ''
}

/** The plain text between two positions, paragraphs separated by a blank line. */
export const textOf = (doc: PMNode, from: number, to: number) => doc.textBetween(from, to, '\n\n', leafText)

/**
 * The plain text of a range, with the document position of every character in it, so a diff
 * computed on text can be drawn and applied in the document.
 */
export function textMap(doc: PMNode, from: number, to: number) {
  let text = ''
  const offs: number[] = []
  let prevEnd = -1
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      const start = Math.max(from, pos + 1)
      if (prevEnd >= 0) {
        // A paragraph break reads as a blank line: from the end of one block to the start of the next.
        text += '\n\n'
        offs.push(prevEnd, start)
      }
      prevEnd = Math.min(to, pos + node.nodeSize - 1)
      return true
    }
    if (node.isText) {
      const s = Math.max(from, pos)
      const e = Math.min(to, pos + node.nodeSize)
      for (let p = s; p < e; p++) {
        text += node.text![p - pos]
        offs.push(p)
      }
      return false
    }
    if (node.isInline) {
      const t = leafText(node)
      for (let k = 0; k < t.length; k++) offs.push(pos)
      text += t
      return false
    }
    return true
  })
  return { text, pos: (offset: number) => (offset < offs.length ? offs[offset] : to) }
}

/** The textblock (paragraph, heading, list item text) around a position. */
export function paragraphAt(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(Math.max(0, Math.min(state.doc.content.size, pos)))
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).isTextblock) return { from: $pos.start(d), to: $pos.end(d), after: $pos.after(d) }
  }
  return { from: pos, to: pos, after: pos }
}

/** Where a card for help about a position goes: straight after its block. */
export const blockEnd = (state: EditorState, pos: number) => paragraphAt(state, pos).after

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

export function changedRatio(original: string, hunks: Hunk[]) {
  const changedWords = hunks.filter((h): h is Hunk & { kind: 'chg' } => h.kind === 'chg').reduce((n, h) => n + h.del.split(/\s+/).filter(Boolean).length, 0)
  const total = original.split(/\s+/).filter(Boolean).length || 1
  return changedWords / total
}

export function sentenceAround(text: string, offset: number) {
  const before = text.slice(0, offset)
  const start = Math.max(before.search(/[^.!?]*$/), 0)
  const rest = text.slice(offset)
  const endRel = rest.search(/[.!?](\s|$)/)
  const end = endRel < 0 ? text.length : offset + endRel + 1
  return text.slice(start, end).trim()
}

export type { EditorView }
