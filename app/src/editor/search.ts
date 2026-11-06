// Find and replace: matches are highlighted as decorations, and replacing goes through the document
// model like any other edit (so formatting around a match is kept).
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { textMap } from './help.ts'

export interface Match {
  from: number
  to: number
}
interface SearchState {
  query: string
  matchCase: boolean
  matches: Match[]
  current: number
}

export const searchKey = new PluginKey<SearchState>('search')

function findAll(doc: PMNode, query: string, matchCase: boolean): Match[] {
  if (!query) return []
  const out: Match[] = []
  const q = matchCase ? query : query.toLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const map = textMap(doc, pos + 1, pos + node.nodeSize - 1)
    const text = matchCase ? map.text : map.text.toLowerCase()
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) out.push({ from: map.pos(i), to: map.pos(i + q.length) })
    return false
  })
  return out
}

export function searchPlugin() {
  return new Plugin<SearchState>({
    key: searchKey,
    state: {
      init: () => ({ query: '', matchCase: false, matches: [], current: 0 }),
      apply(tr, value) {
        const meta = tr.getMeta(searchKey) as Partial<SearchState> | undefined
        if (!meta && !tr.docChanged) return value
        const next = { ...value, ...meta }
        next.matches = findAll(tr.doc, next.query, next.matchCase)
        next.current = Math.min(next.current, Math.max(0, next.matches.length - 1))
        return next
      },
    },
    props: {
      decorations(state) {
        const s = searchKey.getState(state)
        if (!s?.matches.length) return null
        return DecorationSet.create(
          state.doc,
          s.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === s.current ? 'pm-match is-current' : 'pm-match' })),
        )
      },
    },
  })
}

export const searchState = (state: EditorState) => searchKey.getState(state)!

export function setSearch(view: EditorView, patch: Partial<SearchState>) {
  view.dispatch(view.state.tr.setMeta(searchKey, patch))
  reveal(view)
}

/** Move to the next (or previous) match and show it. */
export function step(view: EditorView, delta: number) {
  const s = searchState(view.state)
  if (!s.matches.length) return
  setSearch(view, { current: (s.current + delta + s.matches.length) % s.matches.length })
}

function reveal(view: EditorView) {
  const s = searchState(view.state)
  const m = s.matches[s.current]
  if (!m) return
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView()
  view.dispatch(tr)
}

export function replaceCurrent(view: EditorView, text: string) {
  const s = searchState(view.state)
  const m = s.matches[s.current]
  if (!m) return
  view.dispatch(text ? view.state.tr.insertText(text, m.from, m.to) : view.state.tr.delete(m.from, m.to))
  reveal(view)
}

export function replaceAll(view: EditorView, text: string) {
  const s = searchState(view.state)
  if (!s.matches.length) return 0
  const tr = view.state.tr
  // From the end, so earlier positions stay valid.
  for (const m of [...s.matches].reverse()) {
    if (text) tr.insertText(text, m.from, m.to)
    else tr.delete(m.from, m.to)
  }
  view.dispatch(tr)
  return s.matches.length
}
