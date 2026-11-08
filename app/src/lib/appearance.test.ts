import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { APPEARANCE_DEFAULTS, appearanceVars, cleanAppearance, cleanFamily, cleanSnippet, fontStack, kindsInExcluded, newNoteFolder, searchRows } from './appearance.ts'
import { DEFAULT_KINDS } from './kinds.ts'

test('settings from an older version load with defaults', () => {
  assert.deepEqual(cleanAppearance({}), APPEARANCE_DEFAULTS)
})

test('wrong types, unknown choices and out-of-range numbers fall back or clamp', () => {
  const a = cleanAppearance({ font: 'comic', textSize: 99, lineWidth: 'huge', lineHeight: 3, paragraphSpacing: null, wordCount: 'no', autosaveMs: 5, newDocView: 'pdf', newNotesIn: 'elsewhere' })
  assert.equal(a.font, 'serif')
  assert.equal(a.textSize, 22)
  assert.equal(a.lineWidth, 'comfortable')
  assert.equal(a.lineHeight, 'normal')
  assert.equal(a.paragraphSpacing, 'half')
  assert.equal(a.wordCount, true)
  assert.equal(a.autosaveMs, 400)
  assert.equal(a.newDocView, 'page')
  assert.equal(a.newNotesIn, 'current')
  assert.equal(cleanAppearance({ textSize: 9 }).textSize, 14)
  assert.equal(cleanAppearance({ textSize: 17.3 }).textSize, 17.5)
  assert.equal(cleanAppearance({ textSize: Number.NaN }).textSize, 18.5)
  assert.equal(cleanAppearance({ autosaveMs: 1234 }).autosaveMs, 1200)
})

test('a custom font needs a family; families are made safe for CSS', () => {
  assert.equal(cleanAppearance({ font: 'custom' }).font, 'serif')
  assert.equal(cleanAppearance({ font: 'custom', fontFamily: 'Iowan Old Style' }).font, 'custom')
  assert.equal(cleanFamily('"Evil"; } body { color: red'), 'Evil body color: red')
  assert.equal(cleanFamily(42), '')
})

test('font stacks always end in a fallback', () => {
  assert.equal(fontStack({ font: 'sans', fontFamily: '' }), 'var(--sans)')
  assert.equal(fontStack({ font: 'custom', fontFamily: 'Not Installed Font' }), '"Not Installed Font", var(--serif)')
  assert.equal(fontStack({ font: 'custom', fontFamily: '' }), 'var(--serif)')
})

test('appearance becomes CSS custom properties', () => {
  const v = appearanceVars({ ...APPEARANCE_DEFAULTS, font: 'sans', textSize: 20, lineWidth: 'wide', lineHeight: 'airy', paragraphSpacing: 'half' })
  assert.deepEqual(v, { '--page-font': 'var(--sans)', '--page-size': '20px', '--page-leading': '1.85', '--para-gap': 'calc(var(--page-leading) * 0.5em)', '--measure': '48rem' })
  // The default column is the one the app always had: 40rem = 640px.
  assert.equal(appearanceVars(APPEARANCE_DEFAULTS)['--measure'], '40rem')
})

test('paragraphs are set apart by default, so a new paragraph reads differently from a line break', () => {
  const gap = appearanceVars(APPEARANCE_DEFAULTS)['--para-gap']
  assert.notEqual(gap, '0')
  // The stylesheet's own default (before settings load) is the same gap.
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  assert.ok(css.includes(`--para-gap: ${gap};`), 'styles.css :root --para-gap matches the default')
  assert.equal(appearanceVars({ ...APPEARANCE_DEFAULTS, paragraphSpacing: 'none' })['--para-gap'], '0')
})

test('snippets must be vault-relative .css files', () => {
  assert.equal(cleanSnippet('snippets/page.css'), 'snippets/page.css')
  assert.equal(cleanSnippet('/snippets/page.css'), 'snippets/page.css')
  assert.equal(cleanSnippet('../outside.css'), '')
  assert.equal(cleanSnippet('.obsidian/snippets/a.css'), '')
  assert.equal(cleanSnippet('notes/a.md'), '')
  assert.equal(cleanAppearance({ cssSnippet: 'x.js' }).cssSnippet, '')
  assert.equal(cleanAppearance({ newNotesFolder: 'a/../b' }).newNotesFolder, '')
})

test('new notes go where the setting says', () => {
  const ctx = { currentFolder: 'notes', platform: 'linkedin', kinds: DEFAULT_KINDS }
  assert.equal(newNoteFolder({ newNotesIn: 'current', newNotesFolder: '' }, ctx), 'notes')
  assert.equal(newNoteFolder({ newNotesIn: 'kind', newNotesFolder: '' }, ctx), 'linkedin')
  assert.equal(newNoteFolder({ newNotesIn: 'kind', newNotesFolder: '' }, { ...ctx, platform: 'unknown' }), 'essays')
  assert.equal(newNoteFolder({ newNotesIn: 'fixed', newNotesFolder: 'drafts/' }, ctx), 'drafts')
  assert.equal(newNoteFolder({ newNotesIn: 'fixed', newNotesFolder: '' }, ctx), '')
})

test('excluding a kind folder is noticed', () => {
  assert.deepEqual(
    kindsInExcluded(DEFAULT_KINDS, ['Essays']).map((k) => k.id),
    ['essay'],
  )
  assert.deepEqual(kindsInExcluded(DEFAULT_KINDS, ['journal']), [])
})

test('settings search matches word starts in labels, keywords and tabs, labels first', () => {
  const rows = [
    { tab: 'writing', id: 'ceiling', label: 'Help ceiling', keywords: 'levels' },
    { tab: 'appearance', id: 'spellcheck', label: 'Spellcheck', keywords: 'spelling typos' },
    { tab: 'appearance', id: 'size', label: 'Text size', keywords: 'font zoom' },
    { tab: 'appearance', id: 'font', label: 'Font', keywords: 'typeface' },
  ]
  const tab = (t: string) => t[0].toUpperCase() + t.slice(1)
  assert.deepEqual(
    searchRows(rows, tab, 'spell').map((r) => r.id),
    ['spellcheck'],
  )
  assert.deepEqual(
    searchRows(rows, tab, 'font').map((r) => r.id),
    ['font', 'size'],
  )
  assert.deepEqual(
    searchRows(rows, tab, 'APPEARANCE size').map((r) => r.id),
    ['size'],
  )
  assert.deepEqual(searchRows(rows, tab, 'eiling'), [])
  assert.deepEqual(searchRows(rows, tab, '   '), [])
})
