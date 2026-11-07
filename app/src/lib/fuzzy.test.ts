import test from 'node:test'
import assert from 'node:assert/strict'
import { duplicateTitles, fold, fuzzy, orderCommands, pushRecent, rankFiles, recentFiles, wordsMatch } from './fuzzy.ts'

test('fold lowers case and drops accents without moving positions', () => {
  assert.equal(fold('Café Ünïcode'), 'cafe unicode')
  assert.equal(fold('Straße').length, 'Straße'.length)
  assert.equal(fold('İx').length, 2)
  assert.equal(fold('a😀b'), 'a😀b')
})

test('fuzzy finds letters in order, or nothing', () => {
  assert.ok(fuzzy('unfin', 'The unfinished room'))
  assert.ok(fuzzy('tur', 'The unfinished room'))
  assert.equal(fuzzy('xyz', 'The unfinished room'), null)
  assert.equal(fuzzy('roomz', 'room'), null)
  assert.equal(fuzzy('mor', 'room'), null) // order matters
  assert.ok(fuzzy('cafe', 'Café notes'))
  assert.ok(fuzzy('CAFÉ', 'cafe notes'))
  assert.deepEqual(fuzzy('', 'anything'), { score: 0, positions: [] })
})

test('fuzzy reports the matched positions, preferring word starts and runs', () => {
  assert.deepEqual(fuzzy('unfin', 'The unfinished room')!.positions, [4, 5, 6, 7, 8])
  // "r" at the start of "room", not the r inside "unfinished"... there isn't one, so check "ur" picks the word start.
  assert.deepEqual(fuzzy('ur', 'The unfinished room')!.positions, [4, 15])
  assert.deepEqual(fuzzy('swm', 'Why slow writing matters')!.positions, [4, 9, 17])
  assert.deepEqual(fuzzy('ae', 'AbcEfg')!.positions, [0, 3]) // camel case counts as a word start
})

test('word starts and runs rank above scattered letters', () => {
  const a = fuzzy('room', 'The unfinished room')!.score
  const b = fuzzy('room', 'rhubarb oolong orchard mill')!.score
  assert.ok(a > b)
  const start = fuzzy('on', 'On craft')!.score
  const mid = fuzzy('on', 'Bacon craft')!.score
  assert.ok(start > mid)
  // An exact title beats a longer one.
  assert.ok(fuzzy('on craft', 'On craft')!.score > fuzzy('on craft', 'On craft and more')!.score)
})

test('rankFiles puts title matches first, then aliases, then paths', () => {
  const files = [
    { path: 'essays/the-unfinished-room.md', title: 'The Unfinished Room', folder: 'essays' },
    { path: 'notes/unfinished-business.md', title: 'Loose ends', folder: 'notes', aliases: ['Unfinished business'] },
    { path: 'unfinished/plan.md', title: 'Plan', folder: 'unfinished' },
    { path: 'notes/other.md', title: 'Other', folder: 'notes' },
  ]
  const r = rankFiles('unfin', files)
  assert.equal(r.length, 3)
  assert.equal(r[0].file.title, 'The Unfinished Room')
  assert.equal(r[0].field, 'title')
  assert.equal(r[1].field, 'alias')
  assert.equal(r[1].alias, 'Unfinished business')
  assert.equal(r[2].field, 'path')
  assert.deepEqual(rankFiles('  ', files), [])
  assert.deepEqual(rankFiles('zzz', files), [])
})

test('rankFiles respects its limit and stays quick on a large vault', () => {
  const files = Array.from({ length: 5000 }, (_, i) => ({ path: `folder${i % 40}/note-${i}.md`, title: `Note number ${i} about writing slowly`, folder: `folder${i % 40}` }))
  const t0 = Date.now()
  const r = rankFiles('nw slow', files, 20)
  assert.equal(r.length, 20)
  assert.ok(Date.now() - t0 < 2000)
})

test('recentFiles lists recent documents first, skips the open one and gone ones, then fills by date', () => {
  const files = [
    { path: 'a.md', mtime: 1 },
    { path: 'b.md', mtime: 5 },
    { path: 'c.md', mtime: 3 },
    { path: 'd.md', mtime: 4 },
  ]
  assert.deepEqual(
    recentFiles(['c.md', 'gone.md', 'a.md', 'b.md'], files, 'b.md', 3).map((f) => f.path),
    ['c.md', 'a.md', 'd.md'],
  )
  assert.deepEqual(
    recentFiles([], files, null).map((f) => f.path),
    ['b.md', 'd.md', 'c.md', 'a.md'],
  )
  assert.deepEqual(recentFiles([], [], null), [])
})

test('pushRecent moves an item to the front without repeats', () => {
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c'])
  assert.deepEqual(pushRecent(['a', 'b'], 'c', 2), ['c', 'a'])
})

test('duplicateTitles finds titles shared by more than one file', () => {
  const dup = duplicateTitles([{ title: 'Notes' }, { title: 'notes ' }, { title: 'Other' }])
  assert.ok(dup.has('notes'))
  assert.ok(!dup.has('other'))
})

test('wordsMatch: every typed word starts a word of the text', () => {
  assert.ok(wordsMatch('thin', 'Thinking Space App'))
  assert.ok(wordsMatch('pan out', 'Panel: Outline App'))
  assert.ok(wordsMatch('', 'anything'))
  assert.ok(!wordsMatch('hink', 'Thinking Space'))
  assert.ok(!wordsMatch('thin zz', 'Thinking Space'))
})

test('orderCommands puts recently used commands first and filters by words', () => {
  const cmds = [
    { id: 'bold', label: 'Bold' },
    { id: 'italic', label: 'Italic' },
    { id: 'thinking', label: 'Thinking Space' },
  ]
  const label = (c: { label: string }) => c.label
  assert.deepEqual(
    orderCommands(cmds, ['thinking', 'gone'], label, '').map((c) => c.id),
    ['thinking', 'bold', 'italic'],
  )
  assert.deepEqual(
    orderCommands(cmds, [], label, 'thin').map((c) => c.id),
    ['thinking'],
  )
})
