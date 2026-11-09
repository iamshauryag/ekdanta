// A proposed change that formats the text, applied as formatting.
//
// The assistant writes asked-for formatting in Markdown ("**the urgent work**", "## What changed", "- First").
// Put into the page as text, that is stars and hashes, which the file then saves escaped (`\*\*`). So such a
// change goes in as marks and blocks, read with the editor's own Markdown reader, and only what the model added
// is read that way: the writer's own text in it was escaped first (lib/rich.ts safeMarkdown), so "2*3*4" and
// "1990. A good year" stay text. The model only ever saw the page as plain text, so what it couldn't see is
// kept: an italic word stays italic, a heading stays a heading, a list item stays in its list, and a page
// link, image or line break in the old text goes back in as itself. Before anything goes in, the result is
// checked: it must read exactly as the change says, keep every page link, and hold only formatting a proposal
// may carry. If not, the change isn't applied and the writer is told.
import { Fragment, Slice, type Mark, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { diffChars } from 'diff'
import { parser } from './markdown.ts'
import { computeHunks, leafText, textMap, type Help, type Hunk, type PageProposal } from './help.ts'
import { BLOCK_KINDS, INLINE_KINDS, kindsOf, plainOf, safeMarkdown } from '../lib/rich.ts'

const parsers = new WeakMap<Schema, ReturnType<typeof parser>>()
const cache = new WeakMap<Schema, Map<string, Rich>>()

type Rich = { fragment: Fragment; text: string; marks: (readonly Mark[])[] }

/** Nodes a proposal never brings in: an image would be fetched by the preview, and the rest isn't formatting a writer asks the assistant for. */
const NEVER = new Set(['image', 'horizontalRule', 'table', 'tableRow', 'tableCell', 'tableHeader', 'codeBlock', 'rawBlock', 'rawInline', 'blockquote', 'pageLink', 'taskList', 'taskItem'])

const strip = (f: Fragment): Fragment => {
  const out: PMNode[] = []
  f.forEach((n) => {
    if (n.type.name === 'image') return
    out.push(n.isLeaf ? n : n.copy(strip(n.content)))
  })
  return Fragment.from(out)
}

/**
 * Markdown (already made safe) as page content, without images, and how it reads on the page (blocks
 * separated by a blank line, as textMap reads the page). Kept per text, since the page draws it often.
 */
export function richOf(schema: Schema, md: string): Rich {
  let byText = cache.get(schema)
  if (!byText) cache.set(schema, (byText = new Map()))
  const hit = byText.get(md)
  if (hit) return hit
  let p = parsers.get(schema)
  if (!p) parsers.set(schema, (p = parser(schema)))
  const parsed = p.parse(md.replace(/\r\n?/g, '\n'))
  const doc = parsed.type.create(parsed.attrs, strip(parsed.content))
  const map = textMap(doc, 0, doc.content.size)
  const rich = { fragment: doc.content, text: map.text, marks: map.marks }
  if (byText.size > 200) byText.clear()
  byText.set(md, rich)
  return rich
}

/** A proposal's change as the page will apply it: the model's Markdown with the writer's own text kept as text. */
export const pageMarkdown = (find: string, replace: string) => safeMarkdown(find, replace)

const LIST_ITEMS = ['listItem', 'taskItem']
const LISTS = ['bulletList', 'orderedList', 'taskList']

/** The depth of the textblock a position is in, or -1. */
function textblockDepth(doc: PMNode, pos: number) {
  const $p = doc.resolve(pos)
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).isTextblock) return d
  return -1
}

/** How a fragment reads, as textMap reads the page. */
function textOfFragment(f: Fragment) {
  let text = ''
  let first = true
  f.descendants((node) => {
    if (node.isTextblock) {
      if (!first) text += '\n\n'
      first = false
      node.forEach((c) => (text += c.isText ? c.text! : leafText(c)))
      return false
    }
    return true
  })
  return text
}

/** Does a fragment hold anything a proposal may never bring in? */
function holdsNever(f: Fragment, keep: Set<PMNode>) {
  let bad = false
  f.descendants((n) => {
    if (NEVER.has(n.type.name) && !keep.has(n)) bad = true
    return !bad
  })
  return bad
}

/**
 * Can `md` (safe Markdown, from pageMarkdown) replace [from, to) of the page as formatting? The same checks
 * applyFormat makes, on a copy: so a change that can't go in is never shown as one that can.
 */
export function formatApplies(tr: Transaction, from: number, to: number, md: string) {
  return build(tr, from, to, md) !== null
}

/**
 * Replace [from, to) of the page with `md` (safe Markdown, from pageMarkdown), as formatting. Within one
 * paragraph (or heading, or list item), when it is one paragraph, only that text changes. Otherwise the
 * paragraphs the range covers are replaced by the blocks it makes. False, and nothing changed, when the
 * result wouldn't be exactly what was proposed.
 */
export function applyFormat(tr: Transaction, from: number, to: number, md: string): boolean {
  const plan = build(tr, from, to, md)
  if (!plan) return false
  if (plan.inline) tr.replaceWith(plan.start, plan.end, plan.content)
  else tr.replaceRange(plan.start, plan.end, new Slice(plan.content, 0, 0))
  return true
}

function build(tr: Transaction, from: number, to: number, md: string): { start: number; end: number; content: Fragment; inline: boolean } | null {
  const schema = tr.doc.type.schema
  // Only formatting a proposal may carry: an image, raw HTML, a rule, a table, a quote or code never goes in.
  if (kindsOf(md).some((k) => !INLINE_KINDS.has(k) && !BLOCK_KINDS.has(k))) return null
  const rich = richOf(schema, md)
  // Read two ways, the change must read the same: the editor's reader and the one the server checked it with.
  if (rich.text !== plainOf(md)) return null
  const before = textMap(tr.doc, from, to)
  if (!faithful(before.text, md, rich.text)) return null
  // Marks the new text takes from the old: each unchanged character keeps its own, and formatting that
  // covered all of the old text (a paragraph in italics) covers the new text too. A link never spreads.
  const extra: (readonly Mark[])[] = new Array(rich.text.length).fill([])
  let shared: readonly Mark[] | null = null
  before.text.split('').forEach((c, i) => {
    if (c === '\n') return
    shared = shared === null ? before.marks[i] : shared.filter((m) => before.marks[i].some((n) => n.eq(m)))
  })
  const common = (shared ?? []).filter((m: Mark) => m.type.name !== 'link' && m.type.name !== 'code')
  // Where each unchanged character of the old text is in the new.
  const moved = new Map<number, number>()
  let o = 0
  let n = 0
  for (const part of diffChars(before.text, rich.text)) {
    const len = part.value.length
    if (part.removed) o += len
    else if (part.added) {
      for (let k = 0; k < len; k++) extra[n + k] = common
      n += len
    } else {
      for (let k = 0; k < len; k++) {
        extra[n + k] = before.marks[o + k]
        moved.set(o + k, n + k)
      }
      o += len
      n += len
    }
  }
  // Inline nodes of the old text (a page link, a line break, an image) go back in as themselves where their
  // text is unchanged. A page link or image whose text the change touched can't be kept: the change isn't applied.
  const splice = new Map<number, { node: PMNode; len: number }>()
  const kept = new Set<PMNode>()
  for (const leaf of before.leaves) {
    const len = leafText(leaf.node).length
    const at = moved.get(leaf.offset)
    const whole = len === 0 || (at !== undefined && Array.from({ length: len }, (_, k) => moved.get(leaf.offset + k) === at + k).every(Boolean))
    // A line break may become a paragraph or list break; anything else must stay.
    const required = leaf.node.type.name !== 'hardBreak'
    if (len > 0 && whole) {
      splice.set(at!, { node: leaf.node, len })
      if (required) kept.add(leaf.node)
    } else if (required) return null
  }

  const d1 = textblockDepth(tr.doc, from)
  const d2 = textblockDepth(tr.doc, to)
  const $from = tr.doc.resolve(from)
  const $to = tr.doc.resolve(to)
  // Code keeps its text as typed: no formatting goes into it.
  if ($from.parent.type.spec.code || $to.parent.type.spec.code) return null
  const one = rich.fragment.childCount === 1 && rich.fragment.firstChild!.type.name === 'paragraph'
  const check = (content: Fragment) => !holdsNever(content, kept) && textOfFragment(content) === rich.text && [...kept].every((k) => contains(content, k))
  if (one && d1 > 0 && $from.sameParent($to)) {
    const para = withMarks(rich.fragment, extra, [$from.parent], splice)
    if (!check(para)) return null
    return { start: from, end: to, content: para.firstChild!.content, inline: true }
  }
  if (d1 < 0 || d2 < 0) return null
  // The textblocks the range covers, as they are now: their kind is kept where the new block is a plain paragraph.
  const old: PMNode[] = []
  tr.doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock) old.push(node)
    return !node.isTextblock
  })
  let content = withMarks(rich.fragment, extra, old, splice)
  if (!check(content)) return null
  let start = $from.before(d1)
  let end = $to.after(d2)
  // Paragraphs already in a list, proposed as a list (the model can't see that they are one): the items
  // replace the items, rather than putting a list inside a list.
  const inItem = (d: number, $p: typeof $from) => d > 1 && LIST_ITEMS.includes($p.node(d - 1).type.name)
  if (inItem(d1, $from) && inItem(d2, $to) && content.childCount === 1 && LISTS.includes(content.firstChild!.type.name)) {
    start = $from.before(d1 - 1)
    end = $to.after(d2 - 1)
    content = content.firstChild!.content
  } else if (inItem(d1, $from) && $from.index(d1 - 1) === 0 && content.childCount >= 1 && !LISTS.includes(content.firstChild!.type.name) && content.firstChild!.type.name !== 'paragraph') {
    // A list item must open with a paragraph: a heading proposed for one stays a paragraph.
    const first = content.firstChild!
    content = content.replaceChild(0, schema.nodes.paragraph.create(null, first.content))
  }
  return { start, end, content, inline: false }
}

const contains = (f: Fragment, node: PMNode) => {
  let found = false
  f.descendants((n) => {
    if (n === node) found = true
    return !found
  })
  return found
}

/**
 * The parsed blocks with `extra` marks added to their characters (counted as textMap counts them), the old
 * text's inline nodes spliced back where their text is, and, where the blocks pair one for one with `old`
 * textblocks, a plain paragraph made the kind the old block was.
 */
function withMarks(fragment: Fragment, extra: (readonly Mark[])[], old: PMNode[], splice: Map<number, { node: PMNode; len: number }>): Fragment {
  let j = 0
  let k = 0
  let first = true
  let skip = 0
  const count = (f: Fragment) => {
    let c = 0
    f.descendants((node) => {
      if (node.isTextblock) c++
      return !node.isTextblock
    })
    return c
  }
  const pair = count(fragment) === old.length
  const walk = (f: Fragment): Fragment => {
    const out: PMNode[] = []
    f.forEach((node) => {
      if (node.isTextblock) {
        if (!first) j += 2
        first = false
        const inline: PMNode[] = []
        let run = ''
        let runMarks: readonly Mark[] = []
        const flush = () => {
          if (run) inline.push(node.type.schema.text(run, runMarks))
          run = ''
        }
        /** One character (or leaf) of the new text at j: an old inline node starts here, or it is still being skipped. */
        const leafHere = (marks: readonly Mark[]) => {
          if (j < skip) return true
          const s = splice.get(j)
          if (!s || !node.type.validContent(Fragment.from(s.node))) return false
          flush()
          let leaf = s.node
          for (const m of marks) if (node.type.allowsMarkType(m.type) && m.type.name !== 'link') leaf = leaf.mark(m.addToSet(leaf.marks))
          inline.push(leaf)
          skip = j + s.len
          return true
        }
        node.content.forEach((c) => {
          if (!c.isText) {
            const len = leafText(c).length
            if (!leafHere(c.marks)) {
              flush()
              inline.push(c)
            }
            j += len
            return
          }
          const text = c.text!
          for (let i = 0; i < text.length; i++, j++) {
            if (leafHere(c.marks)) continue
            let marks = c.marks
            for (const m of extra[j] ?? []) if (node.type.allowsMarkType(m.type)) marks = m.addToSet(marks)
            if (run && !sameSet(marks, runMarks)) flush()
            runMarks = marks
            run += text[i]
          }
        })
        flush()
        const was = pair ? old[k] : undefined
        k++
        const type = was && node.type.name === 'paragraph' && was.type.name !== 'paragraph' && was.type.name !== 'codeBlock' ? was : node
        out.push(type.type.create(type === node ? node.attrs : was!.attrs, Fragment.from(inline), node.marks))
      } else if (node.isLeaf) out.push(node)
      else out.push(node.copy(walk(node.content)))
    })
    return Fragment.from(out)
  }
  return walk(fragment)
}

const sameSet = (a: readonly Mark[], b: readonly Mark[]) => a.length === b.length && a.every((m, i) => m.eq(b[i]))

// ---- Accepting a diff ------------------------------------------------------------------------

/**
 * Insert plain text at a position, inheriting the formatting there: a blank line starts a new
 * paragraph and a single newline is a line break, as the model's own text would read.
 */
export function insertPlain(tr: Transaction, from: number, to: number, text: string) {
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

/**
 * The hunks of a proposal made of separate changes: each plain change diffed word by word on its own, each
 * formatting change one hunk, shown and applied as formatting. Text between them is left alone.
 */
export function partHunks(schema: Schema, original: string, parts: NonNullable<PageProposal['parts']>): Hunk[] {
  const out: Hunk[] = []
  const eq = (text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last?.kind === 'eq') last.text += text
    else out.push({ kind: 'eq', text })
  }
  let pos = 0
  for (const part of [...parts].sort((a, b) => a.start - b.start)) {
    if (part.start < pos) continue
    eq(original.slice(pos, part.start))
    const del = original.slice(part.start, part.end)
    if (part.format) {
      // The writer's own text in it stays text: only what the model added formats.
      const md = pageMarkdown(del, part.replace)
      out.push({ kind: 'chg', del, ins: richOf(schema, md).text, state: 'pending', md, part: part.index })
    } else for (const h of computeHunks(del, part.replace)) h.kind === 'eq' ? eq(h.text) : out.push(h)
    pos = part.end
  }
  eq(original.slice(pos))
  return out
}

type Edit = { from: number; to: number; text: string; md?: string }

/** The changes of a diff that go in: those accepted, and the undecided ones when `pending` is 'accepted'. Document positions. */
export function acceptedEdits(doc: PMNode, h: Pick<Extract<Help, { kind: 'diff' }>, 'from' | 'to' | 'hunks'>, pending: 'accepted' | 'rejected') {
  const map = textMap(doc, h.from, h.to)
  const edits: Edit[] = []
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
      edits.push({ from: map.pos(offset), to: map.pos(offset + x.del.length), text: x.ins, md: x.md })
    }
    offset += x.del.length
  }
  return { edits, accepted, total }
}

/**
 * Apply changes (in document order) in one transaction, from the end so earlier positions stay valid: plain
 * text as text, formatting as formatting. Returns how many formatting changes couldn't go in as proposed
 * (those are left out; the rest go in).
 */
export function applyEdits(tr: Transaction, edits: Edit[]) {
  let refused = 0
  for (const e of [...edits].reverse()) {
    if (e.md === undefined) insertPlain(tr, e.from, e.to, e.text)
    else if (!applyFormat(tr, e.from, e.to, e.md)) refused++
  }
  return refused
}

/** The `part` of each formatting hunk that wouldn't go in exactly as proposed, tried on a copy of the page. */
export function refusedFormats(tr: Transaction, from: number, to: number, hunks: Hunk[]): number[] {
  const map = textMap(tr.doc, from, to)
  const out: number[] = []
  let offset = 0
  for (const x of hunks) {
    if (x.kind === 'eq') {
      offset += x.text.length
      continue
    }
    if (x.md !== undefined && !formatApplies(tr, map.pos(offset), map.pos(offset + x.del.length), x.md)) out.push(x.part ?? -1)
    offset += x.del.length
  }
  return out
}

/** Hunks with neighbouring unchanged runs joined. */
export function mergeEq(hunks: Hunk[]): Hunk[] {
  const out: Hunk[] = []
  for (const h of hunks) {
    const last = out[out.length - 1]
    if (h.kind === 'eq' && last?.kind === 'eq') last.text += h.text
    else out.push(h.kind === 'eq' ? { ...h } : h)
  }
  return out
}

/**
 * Does the page text `result` say what the change said? Every character of the old text the model kept is
 * still there, and nothing is there that the model didn't write: its Markdown symbols may go (they became
 * formatting), but no character may appear that it never sent, like a backslash shown in inline code.
 */
function faithful(old: string, md: string, result: string) {
  const unescaped = md.replace(/\\([!-/:-@[-`{-~])/g, '$1')
  const keptBy = (to: string) => {
    const kept = new Set<number>()
    let added = ''
    let o = 0
    for (const part of diffChars(old, to)) {
      if (part.added) added += part.value
      else {
        if (!part.removed) for (let k = 0; k < part.value.length; k++) kept.add(o + k)
        o += part.value.length
      }
    }
    return { kept, added }
  }
  const model = keptBy(unescaped)
  const page = keptBy(result)
  for (const k of model.kept) if (!page.kept.has(k)) return false
  // What the page added must be found, in order, in what the model added. Line breaks between the blocks it
  // made (a list's items, a heading's line) are the blocks themselves.
  let i = 0
  for (const c of page.added.replace(/\n/g, '')) {
    i = model.added.indexOf(c, i)
    if (i < 0) return false
    i++
  }
  return true
}
