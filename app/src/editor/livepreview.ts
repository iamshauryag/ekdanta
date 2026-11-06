// Live Preview, as in Obsidian: the page reads as formatted text, and the Markdown behind an element
// shows only while the caret is in it. The file on disk is never changed by any of this.
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, showTooltip, type DecorationSet, type Tooltip, type ViewUpdate } from '@codemirror/view'
import { unlink } from './format.ts'
import { scanLine } from './marks.ts'

export interface PreviewOptions {
  /** Where an image in the document can be loaded from. */
  assetUrl: (src: string) => string
  /** Open a [[page]] by its link target. */
  openPage: (target: string) => void
  /** A page's title for a [[link]] without its own text, if the page exists. */
  pageTitle: (target: string) => string | undefined
}

// ---- Widgets ------------------------------------------------------------------------------

class Bullet extends WidgetType {
  constructor(readonly depth: number) {
    super()
  }
  eq(o: Bullet) {
    return o.depth === this.depth
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-marker cm-lp-bullet'
    el.textContent = ['•', '◦', '▪'][this.depth % 3]
    return el
  }
}

class Number_ extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(o: Number_) {
    return o.text === this.text
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-marker cm-lp-number'
    el.textContent = this.text
    return el
  }
}

class Checkbox extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(o: Checkbox) {
    return o.checked === this.checked
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-lp-marker cm-lp-task'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Done' : 'To do')
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('click', (e) => {
      e.preventDefault()
      // Find the `[ ]` on this widget's line now, since the document may have changed since it was drawn.
      const line = view.state.doc.lineAt(view.posAtDOM(wrap))
      const m = line.text.match(/^(\s*[-*+] \[)([ xX])\]/)
      if (!m) return
      const at = line.from + m[1].length
      view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' } })
    })
    wrap.appendChild(box)
    return wrap
  }
  ignoreEvent() {
    return true
  }
}

class Rule extends WidgetType {
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-hr'
    return el
  }
}

class Image extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super()
  }
  eq(o: Image) {
    return o.src === this.src && o.alt === this.alt
  }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-lp-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.title = this.alt
    img.loading = 'lazy'
    img.onerror = () => {
      wrap.classList.add('is-broken')
      wrap.textContent = `Image not found: ${this.alt || this.src}`
    }
    wrap.appendChild(img)
    return wrap
  }
}

const hide = Decoration.replace({})

// ---- Building the decorations --------------------------------------------------------------

const WIKILINK = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g

let focusedView = true
function touches(state: EditorState, from: number, to: number) {
  return focusedView && state.selection.ranges.some((r) => r.from <= to && r.to >= from)
}

function build(view: EditorView, opts: PreviewOptions): DecorationSet {
  const { state } = view
  focusedView = view.hasFocus
  const out: Range<Decoration>[] = []
  const activeLines = new Set<number>()
  // With the caret elsewhere (the title, the panel), the whole page reads as formatted.
  const sel = view.hasFocus ? state.selection.ranges : []
  for (const r of sel) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) activeLines.add(l)
  }
  const lineActive = (pos: number) => activeLines.has(state.doc.lineAt(pos).number)
  const lineClass = (pos: number, cls: string, attrs?: Record<string, string>) => out.push(Decoration.line({ class: cls, attributes: attrs }).range(state.doc.lineAt(pos).from))

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        const heading = name.match(/^ATXHeading(\d)$/)
        if (heading) {
          lineClass(node.from, `cm-lp-h cm-lp-h${heading[1]}`)
          const mark = node.node.getChild('HeaderMark')
          // Hidden even with the caret on the line, as in Notion; Backspace at its start makes it text again.
          if (mark) out.push(hide.range(mark.from, Math.min(node.to, mark.to + 1)))
          return
        }
        switch (name) {
          case 'Blockquote': {
            for (let l = state.doc.lineAt(node.from).number; l <= state.doc.lineAt(node.to).number; l++) lineClass(state.doc.line(l).from, 'cm-lp-quote')
            return
          }
          case 'QuoteMark': {
            {
              const after = state.sliceDoc(node.to, node.to + 1) === ' ' ? 1 : 0
              out.push(hide.range(node.from, node.to + after))
            }
            return
          }
          case 'ListMark': {
            const item = node.node.parent
            const list = item?.parent
            if (!item || !list) return
            let depth = 0
            for (let p = list.parent; p; p = p.parent) if (p.name === 'ListItem') depth++
            const line = state.doc.lineAt(node.from)
            const task = node.node.nextSibling?.name === 'Task' ? node.node.nextSibling.getChild('TaskMarker') : null
            const end = Math.min(line.to, (task ? task.to : node.to) + 1)
            // The marker shows as typed only while the caret is inside it.
            const head = view.hasFocus && state.selection.ranges.some((r) => r.from < end && r.to >= line.from && !(r.empty && r.from === end))
            lineClass(line.from, 'cm-lp-li' + (task && /x/i.test(state.sliceDoc(task.from, task.to)) ? ' cm-lp-done' : ''), { style: `--depth:${depth}` })
            if (head) return
            const widget = task
              ? new Checkbox(/x/i.test(state.sliceDoc(task.from, task.to)))
              : list.name === 'OrderedList'
                ? new Number_(state.sliceDoc(node.from, node.to))
                : new Bullet(depth)
            out.push(Decoration.replace({ widget }).range(line.from, end))
            return
          }
          case 'HorizontalRule': {
            if (!lineActive(node.from)) out.push(Decoration.replace({ widget: new Rule() }).range(node.from, node.to))
            return
          }
          case 'FencedCode': {
            const first = state.doc.lineAt(node.from).number
            const last = state.doc.lineAt(node.to).number
            for (let l = first; l <= last; l++) lineClass(state.doc.line(l).from, 'cm-lp-code' + (l === first ? ' is-first' : '') + (l === last ? ' is-last' : ''))
            return false
          }
          case 'Table': {
            for (let l = state.doc.lineAt(node.from).number; l <= state.doc.lineAt(node.to).number; l++) lineClass(state.doc.line(l).from, 'cm-lp-table')
            return false
          }
          case 'InlineCode': {
            out.push(Decoration.mark({ class: 'cm-lp-code-inline' }).range(node.from, node.to))
            if (touches(state, node.from, node.to)) return
            for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === 'CodeMark') out.push(hide.range(c.from, c.to))
            return
          }
          case 'Image': {
            if (touches(state, node.from, node.to)) return false
            const text = state.sliceDoc(node.from, node.to)
            const m = text.match(/^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?/)
            if (m) out.push(Decoration.replace({ widget: new Image(opts.assetUrl(m[2]), m[1]) }).range(node.from, node.to))
            return false
          }
          case 'Link': {
            const marks = node.node.getChildren('LinkMark')
            const url = node.node.getChild('URL')
            const href = url ? state.sliceDoc(url.from, url.to) : ''
            if (marks.length >= 2) {
              out.push(Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': href, title: `${href}  ·  ⌘-click to open` } }).range(marks[0].to, marks[1].from))
            }
            if (touches(state, node.from, node.to) || marks.length < 2) return false
            out.push(hide.range(node.from, marks[0].to))
            out.push(hide.range(marks[1].from, node.to))
            return false
          }
          case 'URL': {
            // A bare web address (the GFM autolink).
            if (node.node.parent?.name === 'Link' || node.node.parent?.name === 'Image') return
            const href = state.sliceDoc(node.from, node.to)
            out.push(Decoration.mark({ class: 'cm-lp-link', attributes: { 'data-href': href, title: '⌘-click to open' } }).range(node.from, node.to))
            return
          }
        }
      },
    })

    // What the Markdown parser doesn't know: [[wikilinks]] and <u>underline</u>.
    const text = state.sliceDoc(from, to)
    for (const m of text.matchAll(WIKILINK)) {
      const start = from + m.index!
      const end = start + m[0].length
      const target = m[1].trim()
      const shown = m[2] ?? opts.pageTitle(target) ?? target
      const missing = !opts.pageTitle(target)
      if (touches(state, start, end)) {
        out.push(Decoration.mark({ class: 'cm-lp-wikilink' + (missing ? ' is-missing' : ''), attributes: { 'data-page': target } }).range(start + 2, end - 2))
        continue
      }
      out.push(
        Decoration.replace({
          widget: new PageLink(target, shown, missing),
        }).range(start, end),
      )
    }
    // Bold, italic, strikethrough, highlight and underline, as the writer means them (see marks.ts):
    // shown formatted, with the marks out of sight, even mid-word or with a space before the closing marks.
    const STYLE: Record<string, string> = { bold: 'cm-lp-strong', italic: 'cm-lp-em', strike: 'cm-lp-strike', highlight: 'cm-lp-hl', underline: 'cm-lp-u' }
    for (let l = state.doc.lineAt(from).number; l <= state.doc.lineAt(to).number; l++) {
      const line = state.doc.line(l)
      if (/Code/.test(syntaxTree(state).resolveInner(line.from, 1).name)) continue
      for (const sp of scanLine(line.text, line.from)) {
        out.push(hide.range(sp.openFrom, sp.openTo), Decoration.mark({ class: STYLE[sp.mark] }).range(sp.openTo, sp.closeFrom), hide.range(sp.closeFrom, sp.closeTo))
      }
    }
  }
  return Decoration.set(out, true)
}

class PageLink extends WidgetType {
  constructor(
    readonly target: string,
    readonly shown: string,
    readonly missing: boolean,
  ) {
    super()
  }
  eq(o: PageLink) {
    return o.target === this.target && o.shown === this.shown && o.missing === this.missing
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-wikilink' + (this.missing ? ' is-missing' : '')
    el.dataset.page = this.target
    el.textContent = this.shown
    el.title = this.missing ? `No page called “${this.target}” yet` : `${this.target}  ·  ⌘-click to open`
    return el
  }
  ignoreEvent() {
    return false
  }
}

// ---- The card under a link (as in Google Docs): open, edit, remove -------------------------------

interface LinkAt {
  from: number
  to: number
  href?: string
  page?: string
  textFrom: number
  textTo: number
  urlFrom?: number
  urlTo?: number
}

function linkAt(state: EditorState, pos: number): LinkAt | null {
  const line = state.doc.lineAt(pos)
  for (const m of line.text.matchAll(WIKILINK)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos > from && pos < to) {
      const textFrom = m[2] ? from + 2 + m[1].length + 1 : from + 2
      return { from, to, page: m[1].trim(), textFrom, textTo: to - 2 }
    }
  }
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'Link' && pos > n.from && pos < n.to) {
      const marks = n.getChildren('LinkMark')
      const url = n.getChild('URL')
      if (marks.length < 2) return null
      return { from: n.from, to: n.to, href: url ? state.sliceDoc(url.from, url.to) : undefined, textFrom: marks[0].to, textTo: marks[1].from, urlFrom: url?.from, urlTo: url?.to }
    }
  }
  return null
}

function openHref(href: string) {
  if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener')
}

function linkCard(state: EditorState, opts: PreviewOptions): Tooltip | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const link = linkAt(state, sel.head)
  if (!link) return null
  return {
    pos: link.from,
    above: false,
    arrow: false,
    create: (view) => {
      const dom = document.createElement('div')
      dom.className = 'link-card'
      const label = document.createElement('span')
      label.className = 'link-card-target'
      label.textContent = link.page ? (opts.pageTitle(link.page) ?? `${link.page} (no such page yet)`) : (link.href ?? '')
      dom.appendChild(label)
      const button = (text: string, title: string, run: () => void) => {
        const b = document.createElement('button')
        b.textContent = text
        b.title = title
        b.addEventListener('mousedown', (e) => {
          e.preventDefault()
          run()
        })
        dom.appendChild(b)
      }
      if (link.page ? opts.pageTitle(link.page) : link.href && /^(https?:|mailto:)/i.test(link.href)) {
        button('Open', '⌘-click a link to open it', () => (link.page ? opts.openPage(link.page) : openHref(link.href!)))
      }
      if (link.urlFrom !== undefined) {
        button('Edit', 'Change where it goes', () => {
          view.dispatch({ selection: { anchor: link.urlFrom!, head: link.urlTo! } })
          view.focus()
        })
        button('Copy', 'Copy the address', () => navigator.clipboard?.writeText(link.href ?? ''))
      }
      button('Remove', 'Keep the text, remove the link', () => unlink(view, link.from, link.to))
      return { dom, offset: { x: 0, y: 4 } }
    },
  }
}

// ---- The extension -----------------------------------------------------------------------

export function livePreview(opts: PreviewOptions) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view, opts)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view, opts)
      }
    },
    {
      decorations: (v) => v.decorations,
      // The caret steps over hidden marks instead of stopping, unseen, inside them.
      provide: (p) =>
        EditorView.atomicRanges.of((view) => (view.plugin(p)?.decorations ?? Decoration.none).update({ filter: (from, to, d) => d.point && to > from })),
    },
  )

  const card = StateField.define<Tooltip | null>({
    create: (s) => linkCard(s, opts),
    update: (t, tr) => (tr.docChanged || tr.selection ? linkCard(tr.state, opts) : t),
    provide: (f) => showTooltip.from(f),
  })

  // ⌘-click (Ctrl-click) opens a link; a plain click places the caret, so links can be edited.
  const clicks = EditorView.domEventHandlers({
    mousedown: (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.cm-lp-link, .cm-lp-wikilink')
      if (!el || !(e.metaKey || e.ctrlKey)) return false
      e.preventDefault()
      if (el.dataset.page) opts.openPage(el.dataset.page)
      else if (el.dataset.href) openHref(el.dataset.href)
      return true
    },
  })

  return [plugin, card, clicks, EditorView.editorAttributes.of({ class: 'cm-live' })]
}

/** In source mode, links still open on ⌘-click and the card still shows. */
export function linkTools(opts: PreviewOptions) {
  const card = StateField.define<Tooltip | null>({
    create: (s) => linkCard(s, opts),
    update: (t, tr) => (tr.docChanged || tr.selection ? linkCard(tr.state, opts) : t),
    provide: (f) => showTooltip.from(f),
  })
  return [card]
}
