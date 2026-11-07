import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch, joinDoc, joinFrontMatter, listOf, patchContent, patchFrontMatter, splitFrontMatter } from './frontmatter.ts'
import { countTags, docTags, hasTag, inlineTags, metaTags, tagsInText, vaultTagCounts } from './tags.ts'

const doc = (...lines: string[]) => lines.join('\n')

test('reads flat keys, quoted values, dashes in keys and colons in values', () => {
  const fm = splitFrontMatter(doc('---', 'title: "On: Editing"', 'my-key: plain', 'url: https://example.com/a', "quote: 'it''s'", 'empty:', '---', '', 'Body'))
  assert.deepEqual(fm.meta, { title: 'On: Editing', 'my-key': 'plain', url: 'https://example.com/a', quote: "it's", empty: '' })
  assert.equal(fm.body, 'Body')
  assert.equal(fm.readonly, false)
})

test('an unchanged document round-trips byte for byte, unknown keys and comments included', () => {
  const content = doc('---', 'title: Hello', '# a comment', 'weird_key: 12   ', 'aliases: [One, "Two, three"]', 'tags:', '  - craft', '  - essays', 'cssclass: wide', '---', '', 'Text #idea', '')
  assert.equal(joinDoc(splitFrontMatter(content)), content)
})

test('reads inline and block lists', () => {
  const fm = splitFrontMatter(doc('---', 'aliases: [One, "Two, three", \'four\']', 'tags:', '- craft', '- "with: colon"', 'empty: []', '---', 'x'))
  assert.deepEqual(fm.lists, { aliases: ['One', 'Two, three', 'four'], tags: ['craft', 'with: colon'], empty: [] })
  assert.equal(fm.meta.tags, 'craft, with: colon')
  assert.equal(fm.readonly, false)
})

test('a list is rewritten in the style it was found in, and block style when new', () => {
  const flow = patchContent(doc('---', 'tags: [a, b]', '---', '', 'x'), { tags: ['a', 'b', 'c d'] })
  assert.equal(flow, doc('---', 'tags: [a, b, c d]', '---', '', 'x'))
  const block = patchContent(doc('---', 'tags:', '    - a', 'title: T', '---', '', 'x'), { tags: ['a', 'b'] })
  assert.equal(block, doc('---', 'tags:', '    - a', '    - b', 'title: T', '---', '', 'x'))
  const fresh = patchContent(doc('---', 'title: T', '---', '', 'x'), { tags: ['craft', 'essays'] })
  assert.equal(fresh, doc('---', 'title: T', 'tags:', '  - craft', '  - essays', '---', '', 'x'))
})

test('`tags: craft` is one tag, and stays a string unless it changes', () => {
  const content = doc('---', 'tags: craft', 'status: draft', '---', '', 'x')
  const fm = splitFrontMatter(content)
  assert.deepEqual(listOf(fm, 'tags'), ['craft'])
  assert.equal(joinDoc(patchFrontMatter(fm, { tags: ['craft'] })), content)
  assert.equal(joinDoc(patchFrontMatter(fm, { status: 'ready' })), doc('---', 'tags: craft', 'status: ready', '---', '', 'x'))
  assert.equal(joinDoc(patchFrontMatter(fm, { tags: ['craft', 'essays'] })), doc('---', 'tags:', '  - craft', '  - essays', 'status: draft', '---', '', 'x'))
})

test('removing the last item removes the key', () => {
  assert.equal(patchContent(doc('---', 'title: T', 'tags:', '  - craft', '---', '', 'x'), { tags: [] }), doc('---', 'title: T', '---', '', 'x'))
  assert.equal(patchContent(doc('---', 'tags: [a]', '---', '', 'x'), { tags: [] }), 'x')
})

test('CRLF and a BOM: the body has no YAML, and both survive an edit', () => {
  const content = '﻿---\r\ntitle: Obsidian\r\nstatus: draft\r\n---\r\n\r\nLine one\r\nLine two\r\n'
  const fm = splitFrontMatter(content)
  assert.equal(fm.body, 'Line one\nLine two\n')
  assert.equal(fm.meta.status, 'draft')
  assert.equal(fm.eol, '\r\n')
  assert.equal(fm.bom, true)
  assert.equal(joinDoc(fm), content)
  const next = joinDoc(patchFrontMatter(fm, { status: 'published', tags: ['a'] }))
  assert.equal(next, '﻿---\r\ntitle: Obsidian\r\nstatus: published\r\ntags:\r\n  - a\r\n---\r\n\r\nLine one\r\nLine two\r\n')
  assert.ok(!/[^\r]\n/.test(next))
})

test('a BOM without front matter is not part of the body', () => {
  const fm = splitFrontMatter('﻿Hello')
  assert.equal(fm.body, 'Hello')
  assert.equal(joinDoc(fm), '﻿Hello')
})

test('what we cannot model is read-only and never rewritten', () => {
  for (const block of [
    ['author:', '  name: Ann', '  site: x'], // nested map
    ['summary: |', '  two', '  lines'], // block text
    ['tags:', '\t- a'], // tabs
    ['this is not yaml'],
    ['title: "unclosed'],
    ['links: [[a], b]'],
  ]) {
    const content = doc('---', ...block, 'status: draft', '---', '', 'Body')
    const fm = splitFrontMatter(content)
    assert.equal(fm.readonly, true, block.join(' / '))
    assert.ok(fm.problem)
    assert.equal(fm.meta.status, 'draft', 'what can be read still is')
    assert.equal(fm.body, 'Body')
    const edited = joinDoc(patchFrontMatter({ ...fm, body: 'Body, edited' }, { status: 'ready' }))
    assert.equal(edited, content.replace('Body', 'Body, edited'))
    // Older callers that only pass the text keep it too.
    assert.equal(joinFrontMatter(fm.raw, fm.meta, 'B'), doc('---', ...block, 'status: draft', '---', '', 'B'))
  }
})

test('a read-only CRLF block keeps its bytes when the body changes', () => {
  const content = '---\r\nx:\r\n  y: 1\r\n---\r\nBody\r\n'
  const fm = splitFrontMatter(content)
  assert.equal(fm.readonly, true)
  assert.equal(joinDoc({ ...fm, body: 'New\n' }), '---\r\nx:\r\n  y: 1\r\n---\r\nNew\r\n')
})

test('the blank line after the fence is kept as found', () => {
  const tight = doc('---', 'a: 1', '---', 'Body')
  assert.equal(joinDoc(splitFrontMatter(tight)), tight)
  assert.equal(patchContent(tight, { a: '2' }), doc('---', 'a: 2', '---', 'Body'))
})

test('values that YAML would misread are quoted', () => {
  assert.equal(patchContent('x', { title: 'A: B', note: '#not-a-comment', plain: 'fine' }), doc('---', 'title: "A: B"', 'note: "#not-a-comment"', 'plain: fine', '---', '', 'x'))
  const back = splitFrontMatter(patchContent('x', { title: 'A: B', aliases: ['x, y', 'z'] }))
  assert.equal(back.meta.title, 'A: B')
  assert.deepEqual(back.lists.aliases, ['x, y', 'z'])
})

test('applyPatch keeps working on flat meta', () => {
  assert.deepEqual(applyPatch({ a: '1', b: '2' }, { a: null, c: '3', d: ['x', 'y'] }), { b: '2', c: '3', d: 'x, y' })
})

test('an unknown status is preserved', () => {
  const content = doc('---', 'status: imported', 'title: T', '---', '', 'x')
  assert.equal(patchContent(content, { title: 'U' }), doc('---', 'status: imported', 'title: U', '---', '', 'x'))
})

test('fifty keys parse and round-trip', () => {
  const keys = Array.from({ length: 50 }, (_, i) => `key${i}: value ${i}`)
  const content = doc('---', ...keys, '---', '', 'x')
  const fm = splitFrontMatter(content)
  assert.equal(Object.keys(fm.meta).length, 50)
  assert.equal(joinDoc(fm), content)
})

// ---- Tags -------------------------------------------------------------------------------------

test('inline tags: not headings, code, links or URL fragments', () => {
  const body = doc(
    '# Title',
    '## Heading #nottag',
    'An #idea and #writing/craft.',
    'See example.com/#x and a#b and #123.',
    '`#code` and [link](http://x/#frag)',
    '```',
    '#fenced',
    '```',
    '(#paren) #Idea',
  )
  assert.deepEqual(inlineTags(body), ['idea', 'writing/craft', 'paren', 'Idea'])
  assert.deepEqual(tagsInText('#a b'), [{ from: 0, to: 2, tag: 'a' }])
})

test('document tags come from front matter and the text, first casing wins', () => {
  const fm = splitFrontMatter(doc('---', 'tags: [Craft, "#essays"]', '---', '', 'More #craft and #new'))
  assert.deepEqual(docTags(fm), ['Craft', 'essays', 'new'])
  assert.deepEqual(docTags(splitFrontMatter(doc('---', 'tags: craft', '---', 'x'))), ['craft'])
})

test('counts nest under parents and merge case', () => {
  assert.deepEqual(countTags([['writing/craft'], ['Writing'], ['idea', 'IDEA']]), [
    { tag: 'idea', count: 1 },
    { tag: 'writing', count: 2 },
    { tag: 'writing/craft', count: 1 },
  ])
  assert.ok(hasTag(['writing/craft'], 'Writing'))
  assert.ok(!hasTag(['writingx'], 'writing'))
})

test('a page that opens with a rule is text; a block with a key it cannot read is read-only', () => {
  const rule = splitFrontMatter(doc('---', 'Just a thought.', '---', 'More'))
  assert.equal(rule.readonly, false)
  assert.equal(rule.raw, '')
  assert.equal(rule.body, doc('---', 'Just a thought.', '---', 'More'))
  const nested = splitFrontMatter(doc('---', 'x:', '  y: 1', '---', 'Body'))
  assert.equal(nested.readonly, true)
  assert.equal(nested.body, 'Body')
})

test('`tags: craft essays` is two tags in the chips and in the counts', () => {
  const fm = splitFrontMatter(doc('---', 'tags: craft essays', '---', '', 'x'))
  assert.deepEqual(metaTags(fm), ['craft', 'essays'])
  assert.deepEqual(docTags(fm), ['craft', 'essays'])
  // Writing the same two back leaves the line as it was.
  assert.equal(joinDoc(patchFrontMatter(fm, { tags: ['craft', 'essays'] })), doc('---', 'tags: craft essays', '---', '', 'x'))
})

test('the vault counts leave out templates and ideas.md', () => {
  const counts = vaultTagCounts([
    { path: 'essays/a.md', tags: ['craft'] },
    { path: 'templates/essay.md', tags: ['craft', 'template-only'] },
    { path: 'Templates/Post.md', tags: ['craft'] },
    { path: 'ideas.md', tags: ['someday'] },
  ])
  assert.deepEqual(counts, [{ tag: 'craft', count: 1 }])
})
