import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, frontMatterList, occurrence, parseQuery, plainLine, plainLines, ready, snippet, tagsOf, type SearchDoc } from './searchQuery.ts'

const doc = (over: Partial<SearchDoc> & { body?: string }): SearchDoc => ({
  path: over.path ?? 'essays/a.md',
  title: over.title ?? 'A',
  meta: over.meta ?? {},
  lines: over.lines ?? plainLines(over.body ?? ''),
  tags: over.tags ?? [],
})

test('parseQuery reads words, phrases, exclusions, regexes and operators', () => {
  const q = parseQuery('slow "unfinished room" -priya /wr[io]te/ path:essays kind:essay tag:#craft status:draft -tag:old')
  assert.equal(q.error, undefined)
  assert.deepEqual(q.terms, [
    { type: 'text', value: 'slow', phrase: false, negate: false },
    { type: 'text', value: 'unfinished room', phrase: true, negate: false },
    { type: 'text', value: 'priya', phrase: false, negate: true },
    { type: 'regex', source: 'wr[io]te', negate: false },
  ])
  assert.deepEqual(q.filters, [
    { key: 'path', value: 'essays', negate: false },
    { key: 'kind', value: 'essay', negate: false },
    { key: 'tag', value: 'craft', negate: false },
    { key: 'status', value: 'draft', negate: false },
    { key: 'tag', value: 'old', negate: true },
  ])
})

test('parseQuery: quoted operator values, unknown operators, stray dashes and quotes', () => {
  assert.deepEqual(parseQuery('path:"my folder/x"').filters, [{ key: 'path', value: 'my folder/x', negate: false }])
  assert.deepEqual(parseQuery('note:this').terms, [{ type: 'text', value: 'note:this', phrase: false, negate: false }])
  assert.deepEqual(
    parseQuery('a - b').terms.map((t) => (t.type === 'text' ? t.value : '')),
    ['a', '-', 'b'],
  )
  assert.deepEqual(parseQuery('"open ended').terms, [{ type: 'text', value: 'open ended', phrase: true, negate: false }])
  assert.deepEqual(parseQuery('kind: essay').terms.length, 2) // "kind:" with nothing after is text
  assert.deepEqual(parseQuery('/a[/]b/').terms, [{ type: 'regex', source: 'a[/]b', negate: false }])
})

test('a broken regex is an error, not a throw', () => {
  assert.match(parseQuery('/[/').error ?? '', /character class/i)
  assert.match(parseQuery('/(a/').error ?? '', /regex/i)
  assert.match(parseQuery('/abc').error ?? '', /ends with/)
  assert.equal(parseQuery('/a+/').error, undefined)
})

test('ready asks only for queries of two or more characters, without errors, with something positive', () => {
  assert.equal(ready('s').ok, false)
  assert.equal(ready('  s ').ok, false)
  assert.equal(ready('sl').ok, true)
  assert.equal(ready('/[/').ok, false)
  assert.equal(ready('-priya').ok, false)
  assert.equal(ready('kind:essay').ok, true)
})

test('words match anywhere in the document, ignoring case and accents', () => {
  const m = compile(parseQuery('cafe SLOW'))
  assert.ok(m.matches(doc({ body: 'A café.\nWriting slow.' })))
  assert.ok(!m.matches(doc({ body: 'A café only.' })))
  assert.ok(compile(parseQuery('unfinished')).matches(doc({ title: 'The Unfinished Room', body: 'Nothing here' })))
})

test('matchCase makes case and accents count', () => {
  const m = compile(parseQuery('Café'), { matchCase: true })
  assert.ok(m.matches(doc({ body: 'Café' })))
  assert.ok(!m.matches(doc({ body: 'café' })))
  assert.ok(!m.matches(doc({ body: 'Cafe' })))
})

test('phrases and exclusions', () => {
  const m = compile(parseQuery('"unfinished room" -priya'))
  assert.ok(m.matches(doc({ body: 'the unfinished room stays' })))
  assert.ok(!m.matches(doc({ body: 'the unfinished, room' })))
  assert.ok(!m.matches(doc({ body: 'the unfinished room\nDear Priya' })))
  assert.ok(!m.matches(doc({ title: 'Note to Priya', body: 'the unfinished room' })))
})

test('regexes match case-insensitively by default and skip empty matches', () => {
  const m = compile(parseQuery('/wr[io]te/'))
  assert.ok(m.matches(doc({ body: 'I WROTE it' })))
  assert.ok(m.matches(doc({ body: 'I write' })))
  assert.ok(!m.matches(doc({ body: 'writing' })))
  assert.deepEqual(m.ranges('they wrote and write'), [
    [5, 10],
    [15, 20],
  ])
  assert.deepEqual(compile(parseQuery('/x*/')).ranges('axxb'), [[1, 3]])
  assert.ok(compile(parseQuery('/cafe/')).matches(doc({ body: 'Café' })))
})

test('filters: path, kind (with names), tag (with children), status (draft by default)', () => {
  const essay = doc({ path: 'essays/slow.md', meta: { platform: 'essay', status: 'published' }, tags: ['craft/editing'] })
  const email = doc({ path: 'emails/priya.md', meta: { platform: 'email' }, tags: ['craft'] })
  const bare = doc({ path: 'notes/x.md' })
  const run = (q: string, d: SearchDoc, kindIds?: (v: string) => string[]) => compile(parseQuery(q), { kindIds }).matches(d)
  assert.ok(run('path:essays', essay))
  assert.ok(!run('path:essays', email))
  assert.ok(run('kind:essay', essay))
  assert.ok(!run('kind:essay', email))
  assert.ok(!run('kind:essay', bare)) // no kind is never a pretend essay
  // The kind is the folder's when the server says so: front matter that disagrees doesn't count.
  const byFolder = (q: string, d: SearchDoc, kindIds?: (v: string) => string[]) => compile(parseQuery(q), { kindIds, kindOf: (x) => (x.path.startsWith('essays/') ? 'essay' : '') }).matches(d)
  const stray = doc({ path: 'essays/odd.md', meta: { platform: 'email' } })
  assert.ok(byFolder('kind:essay', stray))
  assert.ok(!byFolder('kind:email', stray))
  assert.ok(byFolder('kind:unfiled', bare, (v) => (v === 'unfiled' ? [''] : [v])))
  assert.ok(run('kind:essay kind:email', email)) // one key's values are alternatives
  assert.ok(run('kind:Mail', email, (v) => (v.toLowerCase() === 'mail' ? ['email'] : [v])))
  assert.ok(run('tag:craft', essay)) // nested tag
  assert.ok(run('tag:craft', email))
  assert.ok(!run('tag:craft/edit', essay)) // whole segments only
  assert.ok(run('tag:Craft/Editing', essay))
  assert.ok(!run('-tag:craft', email))
  assert.ok(run('status:draft', email))
  assert.ok(run('status:published', essay))
  assert.ok(!run('status:draft', essay))
  assert.ok(!run('path:essays status:draft', essay))
})

test('ranges merge overlapping matches of several terms', () => {
  const m = compile(parseQuery('room roo -x'))
  assert.deepEqual(m.ranges('a room'), [[2, 6]])
  assert.deepEqual(m.ranges('nothing'), [])
})

test('plainLine takes Markdown syntax out', () => {
  assert.equal(plainLine('## A *slow* **bold** heading'), 'A slow bold heading')
  assert.equal(plainLine('> - [ ] a [link](http://x.y) and [[page|label]] and [[other]]'), 'a link and label and other')
  assert.equal(plainLine('2 * 3 * 4 and snake_case_name'), '2 * 3 * 4 and snake_case_name')
  assert.equal(plainLine('==mark== ~~gone~~ `code` ![alt](a.png)'), 'mark gone code alt')
  assert.deepEqual(plainLines('a\n```js\ncode\n```'), ['a', '', 'code', ''])
})

test('front-matter lists and tags', () => {
  const content = '---\ntitle: X\ntags: [craft, "editing"]\naliases:\n  - Room\n  - The room\n---\nBody #inline and #craft/notes, not #1 or `#code` or a#b\n```\n#fenced\n```\n'
  assert.deepEqual(frontMatterList(content, 'aliases'), ['Room', 'The room'])
  assert.deepEqual(frontMatterList(content, 'tags'), ['craft', 'editing'])
  assert.deepEqual(frontMatterList('no front matter', 'tags'), [])
  const body = content.slice(content.indexOf('---\n', 4) + 4)
  assert.deepEqual(tagsOf(content, body).sort(), ['craft', 'craft/notes', 'editing', 'inline'])
  // ' #' starts a YAML comment. Search now reads these as the sidebar's Tags group does (docTags).
  assert.deepEqual(tagsOf('---\ntags: a #b\n---\n', ''), ['a'])
  assert.deepEqual(tagsOf('---\ntags: #a #b\n---\n', ''), ['a'])
})

test('front-matter lists read as the shared parser reads them: CRLF, BOM, unindented items, any key case', () => {
  assert.deepEqual(frontMatterList('---\r\ntitle: X\r\naliases: [Room, "The room"]\r\n---\r\nBody', 'aliases'), ['Room', 'The room'])
  assert.deepEqual(frontMatterList('﻿---\naliases:\n  - Room\n---\nBody', 'aliases'), ['Room'])
  assert.deepEqual(frontMatterList('---\naliases:\n- Room\n- "The: room"\ntitle: X\n---\nBody', 'aliases'), ['Room', 'The: room'])
  assert.deepEqual(frontMatterList('---\nAliases: Room, The room\n---\n', 'aliases'), ['Room', 'The room'])
  assert.deepEqual(frontMatterList('---\ntitle: X\n---\n', 'aliases'), [])
  // A horizontal rule at the top is text, not front matter.
  assert.deepEqual(frontMatterList('---\nJust a rule\n---\n', 'aliases'), [])
})

test('a key the parser cannot read is split as plain text, as before', () => {
  for (const v of ['@home', '*Star*', '!x', '&x']) assert.deepEqual(frontMatterList(`---\ntitle: X\naliases: ${v}\n---\n`, 'aliases'), [v])
  assert.deepEqual(frontMatterList('---\naliases: [a, [b]]\n---\n', 'aliases'), ['a', '[b]'])
  assert.deepEqual(frontMatterList('---\naliases: [a, {b}]\n---\n', 'aliases'), ['a', '{b}'])
  assert.deepEqual(frontMatterList('---\naliases:\n\t- Room\n\t- The room\n---\n', 'aliases'), ['Room', 'The room'])
  assert.deepEqual(frontMatterList('---\r\naliases:\r\n\t- Room\r\n---\r\n', 'aliases'), ['Room'])
  // A block scalar reads as the old split read it (its marker), rather than vanishing.
  assert.deepEqual(frontMatterList('---\naliases: |\n  Room\n---\n', 'aliases'), ['|'])
  assert.deepEqual(tagsOf('---\ntags:\n\t- craft\n---\n', ''), ['craft'])
  // Another key's problem doesn't stop a readable key from being read properly.
  assert.deepEqual(frontMatterList('---\nnote: @x\naliases: Room #1\n---\n', 'aliases'), ['Room'])
})

test('the YAML-correct readings stay: comments, doubled quotes, the last duplicate key', () => {
  assert.deepEqual(frontMatterList('---\naliases: Room #1\n---\n', 'aliases'), ['Room'])
  assert.deepEqual(frontMatterList("---\naliases: ['it''s', b]\n---\n", 'aliases'), ["it's", 'b'])
  assert.deepEqual(frontMatterList('---\naliases: A\naliases: B\n---\n', 'aliases'), ['B'])
})

test('snippets are about 80 characters around the first match, cut at words', () => {
  const short = snippet('  a slow day', [[4, 8]])
  assert.deepEqual(short, { text: 'a slow day', ranges: [[2, 6]] })
  const line = 'word '.repeat(30) + 'MATCH ' + 'tail '.repeat(30)
  const at = line.indexOf('MATCH')
  const s = snippet(line, [[at, at + 5]])
  assert.ok(s.text.length <= 82, String(s.text.length))
  assert.ok(s.text.startsWith('…') && s.text.endsWith('…'))
  const [[a, b]] = s.ranges
  assert.equal(s.text.slice(a, b), 'MATCH')
  // A match at the very end is kept.
  const end = 'x '.repeat(60) + 'END'
  const e = snippet(end, [[end.length - 3, end.length]])
  assert.equal(e.text.slice(e.ranges[0][0], e.ranges[0][1]), 'END')
})

test('occurrence counts exact earlier matches, as the page does', () => {
  const lines = ['slow and slow', 'not here', 'slow again']
  assert.equal(occurrence(lines, 0, 0, 'slow'), 0)
  assert.equal(occurrence(lines, 0, 9, 'slow'), 1)
  assert.equal(occurrence(lines, 2, 0, 'slow'), 2)
  assert.equal(occurrence(lines, 2, 0, 'Slow'), 0)
})
