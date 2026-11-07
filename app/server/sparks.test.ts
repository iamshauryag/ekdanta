// Sparks' pure logic with fixed vectors: the similarity band, MMR diversity, and checking the model's citations.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SOURCES, SPARK_KEY, appendBullet, candidateGroups, cosine, keyOf, mmr, passageId, sample, seenBefore, shortTitle, validateSparks, type Group, type Passage } from './sparks.ts'

/** A unit vector at `deg` degrees in the plane: the cosine between two is cos(difference). */
const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]
const p = (id: string, doc: string, deg: number, folder = 'notes'): Passage => ({ id, doc, title: doc, folder, text: `text of ${id}`, vec: at(deg) })
const band = { lo: 0.56, hi: 0.73 } // cos 56° ≈ 0.56, cos 43° ≈ 0.73

test('only partners inside the band pair up: not too far, not the same thought twice', () => {
  const seed = p('s', 'a.md', 0)
  const pool = [
    seed,
    p('same-doc', 'a.md', 50), // same note: never
    p('dup', 'b.md', 10), // cos ≈ 0.98: a restatement, above the band
    p('near', 'c.md', 50), // cos ≈ 0.64: in the band
    p('far', 'd.md', 80), // cos ≈ 0.17: below
  ]
  const groups = candidateGroups([seed], pool, band)
  assert.deepEqual(
    groups.map((g) => g.ids),
    [keyOf(['s', 'near']).split('|')],
  )
})

test('a partner from another folder is preferred over an equally close one from the same folder', () => {
  const seed = p('s', 'a.md', 0)
  const pool = [p('same', 'b.md', 45, 'notes'), p('other', 'c.md', 47, 'essays')]
  const [first] = candidateGroups([seed], pool, band, 1)
  assert.deepEqual(first.ids, keyOf(['s', 'other']).split('|'))
})

test('two partners from two further notes that also relate make a triad', () => {
  const seed = p('s', 'a.md', 0)
  const pool = [p('x', 'b.md', 45), p('y', 'c.md', -45)] // x and y are 90° apart: no triad
  assert.ok(candidateGroups([seed], pool, band).every((g) => g.ids.length === 2))
  const pool2 = [p('x', 'b.md', 45), p('y', 'c.md', 47)] // x·y ≈ 1: above the band, no triad either
  assert.ok(candidateGroups([seed], pool2, band).every((g) => g.ids.length === 2))
  // In 3D: x and y each ~50° from the seed and ~50° from each other.
  const v = (a: number[]) => {
    const n = Math.hypot(...a)
    return a.map((x) => x / n)
  }
  const s3 = { ...seed, vec: [1, 0, 0] }
  const x3 = { ...p('x', 'b.md', 0), vec: v([0.65, 0.76, 0]) }
  const y3 = { ...p('y', 'c.md', 0), vec: v([0.65, 0.35, 0.67]) }
  assert.ok(cosine(x3.vec, y3.vec) > band.lo && cosine(x3.vec, y3.vec) < band.hi)
  const groups = candidateGroups([s3], [x3, y3], band)
  assert.ok(groups.some((g) => g.ids.length === 3 && g.ids.includes('x') && g.ids.includes('y')))
})

test('MMR picks varied groups, not the best group and its near-copies', () => {
  const vecs: Record<string, number[]> = { a: at(0), b: at(1), c: at(2), d: at(3), e: at(90), f: at(91) }
  const docs: Record<string, string> = { a: '1.md', b: '2.md', c: '3.md', d: '4.md', e: '5.md', f: '6.md' }
  const groups: Group[] = [
    { ids: ['a', 'b'], score: 0.9 },
    { ids: ['c', 'd'], score: 0.89 }, // points the same way as a–b
    { ids: ['a', 'c'], score: 0.88 }, // shares a passage with the first
    { ids: ['e', 'f'], score: 0.7 }, // a different idea
  ]
  const picked = mmr(
    groups,
    (id) => vecs[id],
    (id) => docs[id],
    2,
  )
  assert.deepEqual(
    picked.map((g) => g.ids.join()),
    ['a,b', 'e,f'],
  )
})

test('MMR treats the same two notes as a repeat even through different passages', () => {
  const vecs: Record<string, number[]> = { a1: at(0), a2: at(60), b1: at(120), b2: at(180), c: at(240), d: at(300) }
  const docs: Record<string, string> = { a1: 'a.md', a2: 'a.md', b1: 'b.md', b2: 'b.md', c: 'c.md', d: 'd.md' }
  const groups: Group[] = [
    { ids: ['a1', 'b1'], score: 0.9 },
    { ids: ['a2', 'b2'], score: 0.9 },
    { ids: ['c', 'd'], score: 0.6 },
  ]
  const picked = mmr(
    groups,
    (id) => vecs[id],
    (id) => docs[id],
    2,
  )
  assert.deepEqual(
    picked.map((g) => g.ids.join()),
    ['a1,b1', 'c,d'],
  )
})

test("the model's sparks are checked: unknown ids dropped, single-note sparks dropped", () => {
  const labels = new Map([
    ['p1', p('id1', 'a.md', 0)],
    ['p2', p('id2', 'a.md', 10)],
    ['p3', p('id3', 'b.md', 20)],
  ])
  const raw = {
    sparks: [
      { title: 'Both notes', angle: 'A claim.', why: 'They meet.', sources: ['p1', 'p3'], suits: 'essay' },
      { title: 'One note only', angle: 'A summary.', sources: ['p1', 'p2'] },
      { title: 'Made up', angle: 'Cites nothing real.', sources: ['p1', 'p9'] },
      { title: 'A title that runs a little long but stays whole as written here', angle: 'Q?', sources: ['p2', 'p3', 'p7'], suits: 'sonnet' },
      { title: 'Repeat of the first', angle: 'Same passages.', sources: ['p3', 'p1'] },
      { angle: 'No title.', sources: ['p1', 'p3'] },
    ],
  }
  const out = validateSparks(raw, labels, ['essay', 'linkedin'])
  assert.equal(out.length, 2)
  assert.equal(out[0].title, 'Both notes')
  assert.equal(out[0].suits, 'essay')
  assert.deepEqual(out[0].ids, ['id1', 'id3'])
  assert.equal(out[1].title, 'A title that runs a little long but stays whole as written here')
  assert.deepEqual(out[1].ids, ['id2', 'id3']) // p7 doesn't exist
  assert.equal(out[1].suits, undefined) // not a kind
  assert.deepEqual(validateSparks({ nope: true }, labels, []), [])
  assert.deepEqual(validateSparks(null, labels, []), [])
})

test('a pair kept or dismissed is not offered again, nor anything containing it', () => {
  const seen = [['a', 'b']]
  assert.equal(seenBefore(['b', 'a'], seen), true)
  assert.equal(seenBefore(['a', 'b', 'c'], seen), true)
  assert.equal(seenBefore(['a', 'c'], seen), false)
  assert.equal(seenBefore(['a'], [['a', 'b', 'c']]), true)
  assert.equal(seenBefore(['a', 'c'], []), false)
})

test('Keep appends to the list without touching what the writer wrote', () => {
  assert.equal(appendBullet('', '- one'), '# Sparks\n\n- one\n')
  assert.equal(appendBullet('# Sparks\n\n- one\n', '- two'), '# Sparks\n\n- one\n- two\n')
  assert.equal(appendBullet('# Sparks\n\n- one', '- two'), '# Sparks\n\n- one\n- two\n')
  const edited = '# My ideas\n\nSome thoughts of my own.'
  const out = appendBullet(edited, '- two')
  assert.ok(out.startsWith(edited))
  assert.equal(out, edited + '\n\n- two\n')
})

test('sampling caps the pool but keeps what must stay', () => {
  const items = Array.from({ length: 5000 }, (_, i) => i)
  const out = sample(items, 2000, (i) => i === 4999)
  assert.equal(out.length, 2000)
  assert.ok(out.includes(4999))
  assert.equal(new Set(out).size, 2000)
  assert.equal(sample([1, 2], 10).length, 2)
})

test('a long title is cut where a phrase ends, never mid-phrase', () => {
  assert.equal(shortTitle('Who defends the draft: the writer, the day, or the reader?'), 'Who defends the draft: the writer, the day, or the reader?')
  // Past fourteen words: back to the last clause break.
  assert.equal(
    shortTitle('Who defends the draft: the writer who wrote it, the editor who cut it, or the reader who never sees it'),
    'Who defends the draft: the writer who wrote it, the editor who cut it',
  )
  // No break at all: fourteen words, minus small words left dangling at the end.
  assert.equal(shortTitle('one two three four five six seven eight nine ten eleven twelve and the fifteen sixteen'), 'one two three four five six seven eight nine ten eleven twelve')
  assert.equal(shortTitle('  spaced   out  '), 'spaced out')
})

test('a spark citing many passages keeps the first few, and its key is one the API accepts', () => {
  const labels = new Map(Array.from({ length: 9 }, (_, i) => [`p${i + 1}`, p(passageId(`n${i}.md`, `t${i}`), `n${i}.md`, i * 5)] as const))
  const raw = { sparks: [{ title: 'Many', angle: 'A claim.', sources: [...labels.keys()] }] }
  const [s] = validateSparks(raw, labels, [])
  assert.equal(s.ids.length, MAX_SOURCES)
  assert.ok(SPARK_KEY.test(s.key))
  assert.ok(!SPARK_KEY.test(keyOf([...labels.values()].map((x) => x.id))))
  assert.ok(!SPARK_KEY.test(keyOf([passageId('a.md', 'x')])))
})

test('the same paragraph in two notes is two passages', () => {
  assert.notEqual(passageId('a.md', 'Same words.'), passageId('b.md', 'Same words.'))
  assert.equal(passageId('a.md', 'Same  words.\n'), passageId('a.md', 'Same words.'))
})
