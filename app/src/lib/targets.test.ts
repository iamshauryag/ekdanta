import test from 'node:test'
import assert from 'node:assert/strict'
import { countable, formatTarget, isReferencesHeading, pagesFromHeight, pagesFromWords, parseTarget, presetOf, PRESETS, progress, unitLabel, type Target } from './targets.ts'

const t = (raw: string) => parseTarget(raw) as Target

test('targets read the ways a brief writes them', () => {
  assert.deepEqual(parseTarget('1500'), { unit: 'words', min: 1500, max: 1500, single: true })
  assert.deepEqual(parseTarget('1,500 words'), { unit: 'words', min: 1500, max: 1500, single: true })
  assert.deepEqual(parseTarget('1500-2000'), { unit: 'words', min: 1500, max: 2000, single: false })
  assert.deepEqual(parseTarget('1500 – 2000 words'), { unit: 'words', min: 1500, max: 2000, single: false })
  assert.deepEqual(parseTarget('2000-1500'), { unit: 'words', min: 1500, max: 2000, single: false })
  assert.deepEqual(parseTarget('<=750'), { unit: 'words', min: null, max: 750, single: false })
  assert.deepEqual(parseTarget('≤ 750 words'), { unit: 'words', min: null, max: 750, single: false })
  assert.deepEqual(parseTarget('at least 1000'), { unit: 'words', min: 1000, max: null, single: false })
  assert.deepEqual(parseTarget('5 pages'), { unit: 'pages', min: 5, max: 5, single: true })
  assert.deepEqual(parseTarget('5-6 pages'), { unit: 'pages', min: 5, max: 6, single: false })
  assert.deepEqual(parseTarget('5 to 6 Pages'), { unit: 'pages', min: 5, max: 6, single: false })
  assert.deepEqual(parseTarget('1 page'), { unit: 'pages', min: 1, max: 1, single: true })
})

test('no target, and targets that cannot be read', () => {
  assert.equal(parseTarget(''), null)
  assert.equal(parseTarget('   '), null)
  assert.equal(parseTarget(undefined), null)
  for (const bad of ['abc', '0', '-5', '5 pages - 2000 words', '1500-', 'lots', '1e9']) assert.equal(parseTarget(bad), 'invalid', bad)
  assert.equal(formatTarget('invalid'), '?')
  assert.equal(formatTarget(null), '')
})

test('targets show with en dashes and thousands separators', () => {
  assert.equal(formatTarget(parseTarget('1500-2000')), '1,500–2,000')
  assert.equal(formatTarget(parseTarget('1500')), '1,500')
  assert.equal(formatTarget(parseTarget('<=750')), '≤ 750')
  assert.equal(formatTarget(parseTarget('>=1000')), '≥ 1,000')
  assert.equal(formatTarget(parseTarget('5-6 pages')), '5–6')
})

test('progress is neutral on the way, green in range and amber over the maximum', () => {
  assert.equal(progress(1240, t('1500-2000')).state, 'neutral')
  assert.equal(progress(1500, t('1500-2000')).state, 'in')
  assert.equal(progress(2000, t('1500-2000')).state, 'in')
  assert.equal(progress(2001, t('1500-2000')).state, 'over')
  assert.equal(progress(1240, t('1500-2000')).fill, 0.62)
  assert.equal(progress(50, t('<=10')).state, 'over')
  assert.equal(progress(50, t('<=10')).fill, 1)
  assert.equal(progress(700, t('<=750')).state, 'in')
  assert.equal(progress(100, t('<=750')).state, 'neutral')
  // One number means about that many.
  assert.equal(progress(1400, t('1500')).state, 'in')
  assert.equal(progress(1700, t('1500')).state, 'over')
  assert.equal(progress(0, t('1500')).state, 'neutral')
  // Pages are whole.
  assert.equal(progress(4, t('5 pages')).state, 'neutral')
  assert.equal(progress(5, t('5 pages')).state, 'in')
  assert.equal(progress(6, t('5-6 pages')).state, 'in')
  assert.equal(progress(7, t('5-6 pages')).state, 'over')
  assert.equal(progress(5000, t('>=1000')).state, 'in')
})

test('a Works Cited, References or Bibliography section is left out of the count', () => {
  assert.ok(isReferencesHeading('Works Cited'))
  assert.ok(isReferencesHeading('  references: '))
  assert.ok(isReferencesHeading('Bibliography'))
  assert.ok(!isReferencesHeading('References to the sea'))
  const blocks = [
    { heading: 0, text: '', words: 100 },
    { heading: 2, text: 'Method', words: 1 },
    { heading: 0, text: '', words: 50 },
    { heading: 2, text: 'Works Cited', words: 2 },
    { heading: 0, text: '', words: 30 },
    { heading: 3, text: 'Primary', words: 1 },
    { heading: 0, text: '', words: 10 },
  ]
  assert.deepEqual(countable(blocks), { words: 151, excluded: [{ heading: 'Works Cited', words: 43 }] })
  // A heading at the same level ends the section.
  const after = [...blocks, { heading: 2, text: 'Appendix', words: 1 }, { heading: 0, text: '', words: 5 }]
  assert.equal(countable(after).words, 157)
  assert.deepEqual(countable([{ heading: 0, text: '', words: 12 }]), { words: 12, excluded: [] })
})

test('pages, estimated and measured', () => {
  assert.equal(pagesFromWords(0, 'letter'), 0)
  assert.equal(pagesFromWords(1, 'letter'), 1)
  assert.equal(pagesFromWords(1100, 'letter'), 4)
  assert.ok(pagesFromWords(1120, 'a4') < pagesFromWords(1120, 'letter'))
  assert.equal(pagesFromHeight(10, 864), 1)
  assert.equal(pagesFromHeight(864, 864), 1)
  assert.equal(pagesFromHeight(870, 864), 2)
})

// ---- Character limits ----------------------------------------------------------------------

test('character limits read the ways a form writes them', () => {
  assert.deepEqual(parseTarget('4000 characters'), { unit: 'characters', min: 4000, max: 4000, single: true })
  assert.deepEqual(parseTarget('4,000 chars'), { unit: 'characters', min: 4000, max: 4000, single: true })
  assert.deepEqual(parseTarget('4000 character'), { unit: 'characters', min: 4000, max: 4000, single: true })
  assert.deepEqual(parseTarget('<= 1500 characters'), { unit: 'characters', min: null, max: 1500, single: false })
  assert.deepEqual(parseTarget('1000-4000 characters'), { unit: 'characters', min: 1000, max: 4000, single: false })
  assert.deepEqual(parseTarget('4000 characters no spaces'), { unit: 'characters', min: 4000, max: 4000, single: true, noSpaces: true })
  assert.deepEqual(parseTarget('4000 characters (without spaces)'), { unit: 'characters', min: 4000, max: 4000, single: true, noSpaces: true })
  assert.deepEqual(parseTarget('4000 characters, excluding spaces'), { unit: 'characters', min: 4000, max: 4000, single: true, noSpaces: true })
  assert.deepEqual(parseTarget('4000 characters including spaces and line breaks'), { unit: 'characters', min: 4000, max: 4000, single: true })
  assert.deepEqual(parseTarget('4000 characters incl. spaces'), { unit: 'characters', min: 4000, max: 4000, single: true })
  // Spaces only make sense for characters, and the units of a range must agree.
  for (const bad of ['650 words no spaces', 'no spaces', '5 pages without spaces', '100 words - 4000 characters', '0 characters']) assert.equal(parseTarget(bad), 'invalid', bad)
})

test('word and page targets parse exactly as before', () => {
  for (const raw of ['1500', '1,500 words', '1500-2000', '<=750', '>=1000', '5 pages', '5-6 pages', '650 w']) {
    const t = parseTarget(raw) as Target
    assert.notEqual(t.unit, 'characters', raw)
    assert.equal('noSpaces' in t, false, raw)
  }
})

test('a character limit is amber in its last 5% and red past it', () => {
  const ucas = t('4000 characters')
  assert.equal(progress(0, ucas).state, 'neutral')
  assert.equal(progress(3799, ucas).state, 'neutral')
  assert.equal(progress(3800, ucas).state, 'near')
  assert.equal(progress(4000, ucas).state, 'near')
  assert.equal(progress(4001, ucas).state, 'over')
  assert.equal(progress(2000, ucas).fill, 0.5)
  assert.equal(progress(9000, ucas).fill, 1)
  const range = t('1000-4000 characters')
  assert.equal(progress(999, range).state, 'neutral')
  assert.equal(progress(1000, range).state, 'in')
  assert.equal(progress(3800, range).state, 'near')
  assert.equal(progress(4001, range).state, 'over')
  assert.equal(progress(10, t('>= 500 characters')).state, 'neutral')
  assert.equal(progress(600, t('>= 500 characters')).state, 'in')
  // Small limits still have an amber band, never a zero-width one past the limit.
  assert.equal(progress(10, t('10 characters')).state, 'near')
  assert.equal(progress(9, t('10 characters')).state, 'neutral')
  assert.equal(formatTarget(ucas), '4,000')
  assert.equal(unitLabel(ucas), 'characters')
  assert.equal(unitLabel(t('4000 characters no spaces')), 'characters, no spaces')
  assert.equal(unitLabel(t('650 words')), 'words')
})

test('presets write targets the parser reads, and are recognised however they were typed', () => {
  for (const p of PRESETS) assert.notEqual(parseTarget(p.target), 'invalid', p.target)
  assert.equal(PRESETS.find((p) => p.id === 'ucas')!.target, '4000 characters')
  assert.equal(presetOf('4000 characters')?.id, 'ucas')
  assert.equal(presetOf('4,000 chars')?.id, 'ucas')
  assert.equal(presetOf('4000 characters no spaces'), null)
  assert.equal(presetOf('250 - 650 words')?.id, 'commonapp')
  assert.equal(presetOf('≤ 250 words')?.id, 'abstract')
  assert.equal(presetOf('1500'), null)
  assert.equal(presetOf(''), null)
  assert.equal(presetOf('lots'), null)
})
