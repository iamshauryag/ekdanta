import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSchema } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { extensions } from './schema.ts'
import { carryGaps, parseMarkdown, serializeMarkdown } from './markdown.ts'

const schema = getSchema(extensions())

/** What each top-level block holds: its text, with a line break as ⏎ and nested blocks split by |. */
const shape = (doc: PMNode) => {
  const out: string[] = []
  doc.forEach((n) => {
    let s = ''
    n.descendants((c) => {
      if (c.isText) s += c.text
      else if (c.type.name === 'hardBreak') s += '⏎'
      else if (c.isTextblock && s && !s.endsWith('|')) s += '|'
    })
    out.push(`${n.type.name}:${s}`)
  })
  return out
}

/** Open a file, make an edit as the editor would (gaps carried on every change), and save it. */
function edit(text: string, change: (state: EditorState) => Transaction | Transaction[]) {
  const { doc, source } = parseMarkdown(schema, text)
  let state = EditorState.create({ schema, doc })
  const trs = change(state)
  for (const tr of Array.isArray(trs) ? trs : [trs]) {
    const next = state.apply(tr)
    carryGaps(state.doc, next.doc, source)
    state = next
  }
  return serializeMarkdown(state.doc, source)
}

/** Where `needle` ends in the document. */
function posAfter(doc: PMNode, needle: string) {
  let at = -1
  doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text!.includes(needle)) at = pos + n.text!.indexOf(needle) + needle.length
  })
  assert.ok(at >= 0, `no "${needle}"`)
  return at
}
const type = (needle: string, text: string) => (s: EditorState) => s.tr.insertText(text, posAfter(s.doc, needle))
const lineBreak = (needle: string, text?: string) => (s: EditorState) => s.tr.insert(posAfter(s.doc, needle), [schema.nodes.hardBreak.create(), ...(text ? [schema.text(text)] : [])])

test('a single newline is a line break on the page; a blank line is a new paragraph', () => {
  assert.deepEqual(shape(parseMarkdown(schema, 'Roses are red\nViolets are blue\n\nNew paragraph.\n').doc), ['paragraph:Roses are red⏎Violets are blue', 'paragraph:New paragraph.'])
})

test('line breaks in lists, quotes and after a heading are kept', () => {
  assert.deepEqual(shape(parseMarkdown(schema, '# Title\nfirst\nsecond\n\n- one\n  more\n- two\n\n> a\n> b\n').doc), [
    'heading:Title',
    'paragraph:first⏎second',
    'bulletList:one⏎more|two',
    'blockquote:a⏎b',
  ])
})

test('code blocks keep their newlines as text', () => {
  assert.equal(parseMarkdown(schema, '```\nline one\n\nline three\n```\n').doc.firstChild!.textContent, 'line one\n\nline three')
})

test('opening and saving without an edit changes nothing', () => {
  for (const text of ['a\nb\n', 'a  \nb\n', 'a\\\nb\n', '# h\ntext\n', 'a\n\n\n\nb\n', '- a\n  b\n- c\n', '> a\n> b\n', 'a\nb', '\n\na\n']) {
    const { doc, source } = parseMarkdown(schema, text)
    assert.equal(serializeMarkdown(doc, source), text, JSON.stringify(text))
  }
})

test('an edited paragraph writes its plain line breaks as single newlines', () => {
  assert.equal(edit('Roses are red\nViolets are blue\n\nNext.\n', type('red', '!')), 'Roses are red!\nViolets are blue\n\nNext.\n')
})

test('an edited paragraph keeps two-space and backslash breaks as the file wrote them', () => {
  assert.equal(edit('one  \ntwo\\\nthree\n', type('three', '!')), 'one  \ntwo\\\nthree!\n')
  assert.equal(edit('one   \ntwo\n', type('two', '!')), 'one   \ntwo!\n')
})

test('a line break typed with Shift-Return is written as one newline, not doubled', () => {
  const out = edit('First line\n\nNext.\n', lineBreak('First line', 'second line'))
  assert.equal(out, 'First line\nsecond line\n\nNext.\n')
  assert.deepEqual(shape(parseMarkdown(schema, out).doc), ['paragraph:First line⏎second line', 'paragraph:Next.'])
})

test('an edit keeps the blank lines the file had around the block', () => {
  assert.equal(edit('a\n\n\n\nb\n\nc\n', type('a', '!')), 'a!\n\n\n\nb\n\nc\n')
  assert.equal(edit('a\n\n\n\nb\n\nc\n', type('b', '!')), 'a\n\n\n\nb!\n\nc\n')
  // A heading followed straight by its text stays that way.
  assert.equal(edit('# Title\nBody text.\n', type('Title', '!')), '# Title!\nBody text.\n')
  assert.equal(edit('# Title\nBody text.\n', type('Body', '!')), '# Title\nBody! text.\n')
})

test('many keystrokes in a row keep the gap', () => {
  const out = edit('a\n\n\n\nb\n', (s) => {
    const trs: Transaction[] = []
    let state = s
    let typed = 'a'
    for (const ch of 'xyz') {
      const tr = state.tr.insertText(ch, posAfter(state.doc, typed))
      typed += ch
      trs.push(tr)
      state = state.apply(tr)
    }
    return trs
  })
  assert.equal(out, 'axyz\n\n\n\nb\n')
})

test('splitting a paragraph leaves the gap after the second half', () => {
  const out = edit('one two\n\n\nnext\n', (s) => s.tr.split(posAfter(s.doc, 'one ')))
  assert.equal(out, 'one \n\ntwo\n\n\nnext\n')
})

test('one newline is never trusted between blocks that would run together', () => {
  // A heading turned into a paragraph: its single newline would join it to the paragraph below.
  const out = edit('# Title\nBody text.\n', (s) => s.tr.setNodeMarkup(0, schema.nodes.paragraph))
  assert.equal(out, 'Title\n\nBody text.\n')
  assert.deepEqual(shape(parseMarkdown(schema, out).doc), ['paragraph:Title', 'paragraph:Body text.'])
})

test('text after a line break that looks like Markdown stays text', () => {
  for (const line of ['# Not a heading', '- not a list', '+ nor this', '1. nor this', '1) nor this', '> nor a quote', '===', '---']) {
    const out = edit('Intro\n\nEnd.\n', lineBreak('Intro', line))
    assert.deepEqual(shape(parseMarkdown(schema, out).doc), [`paragraph:Intro⏎${line}`, 'paragraph:End.'], `${JSON.stringify(line)} → ${JSON.stringify(out)}`)
  }
})

test('a line break inside a heading is written as a space, so the heading stays whole', () => {
  assert.equal(edit('# Title\n\nBody.\n', lineBreak('Title', 'more')), '# Title more\n\nBody.\n')
})

test('a break at the very end of a paragraph is not written', () => {
  assert.equal(edit('Line\n\nNext.\n', lineBreak('Line')), 'Line\n\nNext.\n')
})

test('lists and quotes with line breaks round-trip through an edit', () => {
  assert.equal(edit('- one\n  more\n- two\n', type('two', '!')), '- one\n  more\n- two!\n')
  assert.equal(edit('- one\n  more\n- two\n', type('more', '!')), '- one\n  more!\n- two\n')
  assert.equal(edit('> a\n> b\n', type('b', '!')), '> a\n> b!\n')
})

test('CRLF bodies read the same as LF ones', () => {
  // A CRLF file's body arrives as LF (lib/frontmatter.ts), and is written back as CRLF.
  assert.deepEqual(shape(parseMarkdown(schema, 'a\r\nb\r\n\r\nc\r\n').doc), ['paragraph:a⏎b', 'paragraph:c'])
})
