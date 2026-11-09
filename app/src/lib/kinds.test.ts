import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_KINDS,
  UNFILED,
  cleanKinds,
  describeKind,
  doubledFolder,
  folderForName,
  isPluralWord,
  isSetApartFolder,
  kindName,
  kindOfFolder,
  kindOfPath,
  kindsFromFolders,
  kindTaken,
  nameFromFolder,
  nameTakenBy,
  newKind,
  pieceName,
  plural,
  singular,
  suggestedKinds,
  topFolder,
  type Kind,
} from './kinds.ts'

test('cleanKinds keeps template and doc fields that are well formed', () => {
  const [k] = cleanKinds([
    { id: 'paper', name: 'Paper', folder: 'papers', guidance: '', words: 2000, template: 'templates/paper.md', doc: { layout: 'page', style: 'apa', paper: 'a4', target: '1500-2000' } },
  ])!
  assert.equal(k.template, 'templates/paper.md')
  assert.deepEqual(k.doc, { layout: 'page', style: 'apa', paper: 'a4', target: '1500-2000' })
})

test('a bad doc field is dropped and the kind is kept', () => {
  const out = cleanKinds([{ id: 'essay', name: 'Essay', folder: 'essays', guidance: '', words: 1200, doc: { style: 'harvard', paper: 'a4', layout: 'scroll', target: 7 } }])!
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].doc, { paper: 'a4' })
  const none = cleanKinds([{ id: 'essay', name: 'Essay', doc: { style: 'harvard' } }])!
  assert.equal('doc' in none[0], false)
  assert.equal('doc' in cleanKinds([{ id: 'essay', doc: 'mla' }])![0], false)
})

test('a template outside the vault or not Markdown is dropped', () => {
  for (const template of ['../secrets.md', '/etc/passwd.md', 'templates/x.txt', 'templates//x.md', 'C:/x.md', '', 5]) {
    const [k] = cleanKinds([{ id: 'essay', template }])!
    assert.equal('template' in k, false, String(template))
  }
})

test('kinds without the new fields come out exactly as before', () => {
  assert.deepEqual(cleanKinds(DEFAULT_KINDS), DEFAULT_KINDS)
})

test('special folders hold a kind only when a kind names them', () => {
  assert.equal(kindOfFolder(DEFAULT_KINDS, 'templates'), undefined)
  assert.equal(kindOfFolder([...DEFAULT_KINDS, { id: 'template', name: 'Template', folder: 'my-templates', guidance: '', words: 300 }], 'templates'), undefined) // no guess from the name
  const kinds = [...DEFAULT_KINDS, { id: 'journal', name: 'Journal', folder: 'journal', guidance: '', words: 300 }]
  assert.equal(kindOfFolder(kinds, 'journal')?.id, 'journal')
  assert.equal(kindOfFolder(kinds, 'essays')?.id, 'essay')
})

test('a kind never files into a special folder', () => {
  assert.equal(newKind('Template', DEFAULT_KINDS)?.folder, 'my-templates')
  assert.equal(newKind('Journal', DEFAULT_KINDS)?.folder, 'journals') // not the special journal/
  assert.equal(newKind('Source', DEFAULT_KINDS)?.folder, 'my-sources')
  assert.equal(newKind('Export', DEFAULT_KINDS)?.folder, 'my-exports')
})

test('a saved kind keeps its folder, even a special one', () => {
  const [kind] = cleanKinds([{ id: 'source', name: 'Source notes', folder: 'sources', guidance: '', words: 300 }])!
  assert.equal(kind.folder, 'sources')
  assert.equal(kindOfFolder([kind], 'sources')?.id, 'source')
  // A kind saved without a folder gets one, and that one avoids special folders.
  assert.equal(cleanKinds([{ id: 'template', name: 'Template', guidance: '', words: 300 }])![0].folder, 'my-templates')
})

// ---- Word rules ----

const TABLE: [typed: string, name: string, folder: string][] = [
  ['YT Scripts', 'YT script', 'yt-scripts'],
  ['IG Captions', 'IG caption', 'ig-captions'],
  ['Essay', 'Essay', 'essays'],
  ['Story', 'Story', 'stories'],
  ['Speech', 'Speech', 'speeches'],
  ['Class notes', 'Class note', 'class-notes'],
  ['News', 'News', 'news'],
  ['Series', 'Series', 'series'],
  ['Thesis', 'Thesis', 'theses'],
  ['Analysis', 'Analysis', 'analyses'],
  ['Box', 'Box', 'boxes'],
  ['Bus', 'Bus', 'buses'],
  ['Course', 'Course', 'courses'],
  ['Email', 'Email', 'emails'],
  ['Text message', 'Text message', 'text-messages'],
  ['Letters', 'Letter', 'letters'],
]

test('a new kind is named in the singular and files into the plural', () => {
  for (const [typed, name, folder] of TABLE) {
    const k = newKind(typed, [])!
    assert.equal(k.name, name, typed)
    assert.equal(k.folder, folder, typed)
  }
  assert.equal(newKind('YT Scripts', [])!.id, 'yt-scripts')
})

test('plural and singular undo each other and never double up', () => {
  for (const [w, p] of [
    ['script', 'scripts'],
    ['story', 'stories'],
    ['speech', 'speeches'],
    ['thesis', 'theses'],
    ['analysis', 'analyses'],
    ['box', 'boxes'],
    ['bus', 'buses'],
    ['course', 'courses'],
    ['case', 'cases'],
    ['house', 'houses'],
    ['response', 'responses'],
    ['class', 'classes'],
    ['buzz', 'buzzes'],
    ['wish', 'wishes'],
    ['day', 'days'],
    ['movie', 'movies'],
    ['news', 'news'],
    ['series', 'series'],
    ['species', 'species'],
  ]) {
    assert.equal(plural(w), p, w)
    assert.equal(plural(p), p, `${p} is already plural`)
    assert.equal(singular(p), w, p)
    assert.equal(singular(w), w, `${w} is already singular`)
  }
  assert.equal(plural('YT Scripts'), 'YT Scripts')
  assert.equal(plural('yt-script'), 'yt-scripts')
  assert.equal(singular('yt-scripts'), 'yt-script')
  assert.equal(plural('LinkedIn post'), 'LinkedIn posts')
})

test('isPluralWord', () => {
  for (const w of ['scripts', 'stories', 'theses', 'courses', 'Captions']) assert.equal(isPluralWord(w), true, w)
  for (const w of ['script', 'class', 'bus', 'thesis', 'news', 'series', 'species', 'ब्लॉग', '']) assert.equal(isPluralWord(w), false, w)
})

test('a real singular ending in s keeps its s', () => {
  for (const w of ['canvas', 'Lens', 'atlas', 'bias', 'gas', 'alias', 'physics', 'statistics', 'chaos', 'kudos']) assert.equal(isPluralWord(w), false, w)
  // The plural adds -es, and the singular of that comes back whole.
  assert.equal(plural('Canvas'), 'Canvases')
  assert.equal(singular('Canvases'), 'Canvas')
  assert.equal(singular('lenses'), 'lens')
  assert.equal(singular('gases'), 'gas')
  // A mass noun has no second form, so neither rule touches it.
  assert.equal(plural('Physics'), 'Physics')
  assert.equal(singular('Physics'), 'Physics')
  // The kind is named Canvas, not Canva, and files into canvases/.
  const k = newKind('Canvas', [])!
  assert.equal(k.name, 'Canvas')
  assert.equal(k.folder, 'canvases')
  // Typed as a plural, it still lands on the right singular.
  assert.equal(newKind('Lenses', [])!.name, 'Lens')
  assert.equal(newKind('Lenses', [])!.folder, 'lenses')
  // Loading saved settings leaves the writer's own name alone, however often it is loaded.
  const saved = cleanKinds([
    { id: 'canvas', name: 'Canvas', folder: 'canvases' },
    { id: 'lens', name: 'Lens', folder: 'lenses' },
    { id: 'atlas', name: 'Atlas', folder: 'atlases' },
  ])!
  assert.deepEqual(
    saved.map((k) => k.name),
    ['Canvas', 'Lens', 'Atlas'],
  )
  assert.deepEqual(cleanKinds(saved), saved, 'idempotent')
  // Nor is canvases/ mistaken for the old doubled plural.
  assert.deepEqual(
    saved.map((k) => doubledFolder(k)),
    [null, null, null],
  )
})

test('-is words only change where the pair is real', () => {
  assert.equal(plural('Thesis'), 'Theses')
  assert.equal(plural('Analysis'), 'Analyses')
  assert.equal(plural('Crisis'), 'Crises')
  assert.equal(plural('Synopsis'), 'Synopses')
  // Not every -is word is Greek: an iris has irises, not ires.
  assert.equal(plural('Iris'), 'Irises')
  assert.equal(singular('Irises'), 'Iris')
})

test('other scripts keep their letters, uninflected', () => {
  for (const name of ['ब्लॉग', '日記', '한국어']) {
    const k = newKind(name, [])!
    assert.equal(k.name, name)
    assert.equal(k.id, name)
    assert.equal(k.folder, name)
  }
  // Hangul stays composed: one code point per syllable, not jamo.
  assert.equal(newKind('한국어'.normalize('NFD'), [])!.id, '한국어')
  assert.equal(Array.from(newKind('한국어', [])!.id).length, 3)
  assert.ok(cleanKinds([{ id: 'ब्लॉग', name: 'ब्लॉग' }]))
})

test('a name with nothing nameable gets kind-n', () => {
  assert.equal(newKind('🎬', [])!.id, 'kind-1')
  const one = newKind('🎬', [])!
  assert.equal(newKind('📸', [one])!.id, 'kind-2')
  assert.equal(newKind('   ', []), null)
})

test('a name is taken by its singular or plural', () => {
  const scripts = newKind('Scripts', [])!
  assert.equal(kindTaken([scripts], 'Script'), true)
  assert.equal(kindTaken([scripts], 'scripts'), true)
  assert.equal(newKind('Script', [scripts]), null)
  assert.equal(kindTaken(DEFAULT_KINDS, 'Emails'), true)
  assert.equal(kindTaken(DEFAULT_KINDS, 'Letter'), false)
  // An old, unmigrated name still counts.
  assert.equal(kindTaken([{ ...scripts, name: 'YT Scripts' }], 'YT script'), true)
})

test('renaming a kind to a name another kind has is refused', () => {
  const kinds: Kind[] = [
    { id: 'essay', name: 'Essay', folder: 'essays', guidance: '', words: 1200 },
    { id: 'yt-scripts', name: 'YT script', folder: 'yt-scripts', guidance: '', words: 800 },
  ]
  // The plural, the singular and a different casing all count as the same name.
  assert.equal(nameTakenBy(kinds, 'yt-scripts', 'Essay')?.id, 'essay')
  assert.equal(nameTakenBy(kinds, 'yt-scripts', 'Essays')?.id, 'essay')
  assert.equal(nameTakenBy(kinds, 'yt-scripts', ' essay ')?.id, 'essay')
  // A kind may always keep, re-case or re-plural its own name.
  assert.equal(nameTakenBy(kinds, 'essay', 'Essay'), undefined)
  assert.equal(nameTakenBy(kinds, 'essay', 'Essays'), undefined)
  // A free name is free.
  assert.equal(nameTakenBy(kinds, 'essay', 'Letter'), undefined)
})

test('colliding ids stay within 40 characters, and folders stay apart', () => {
  const first = newKind('Letter!', [])!
  const second = newKind('Letter?', [first])!
  assert.equal(second.id, 'letter-2')
  const third = newKind('x'.repeat(40), [{ ...first, id: 'x'.repeat(40), name: 'Other' }])!
  assert.equal(third.id.length, 40)
  assert.match(third.id, /-2$/)
  assert.ok(cleanKinds([third]), 'cleanKinds keeps it')
  // "Text" would share texts/ with Text message.
  const text = newKind('Text', DEFAULT_KINDS)!
  assert.equal(text.id, 'text-2')
  assert.equal(text.folder, 'texts-2')
})

test('saved plural names read singular, and only doubled plurals are flagged', () => {
  const kinds = cleanKinds([
    { id: 'yt-scripts', name: 'YT Scripts', folder: 'yt-scriptses' },
    { id: 'course', name: 'Course', folder: 'courses' },
    { id: 'courses', name: 'Courses', folder: 'courseses' },
    { id: 'speech', name: 'Speech', folder: 'speeches' },
    { id: 'response', name: 'Response', folder: 'responses' },
  ])!
  assert.deepEqual(
    kinds.map((k) => k.name),
    ['YT script', 'Course', 'Course', 'Speech', 'Response'],
  )
  assert.deepEqual(
    kinds.map((k) => doubledFolder(k)),
    ['yt-scripts', null, 'courses', null, null],
  )
  // The folder itself is never rewritten here: the server checks the disk first.
  assert.equal(kinds[0].folder, 'yt-scriptses')
  assert.deepEqual(cleanKinds(kinds), kinds, 'idempotent')
})

test('pieces read correctly even from an unmigrated name', () => {
  const kinds: Kind[] = [{ id: 'yt-scripts', name: 'YT Scripts', folder: 'yt-scripts', guidance: '', words: 800 }]
  assert.equal(pieceName(kinds, 'yt-scripts', 1), 'YT script')
  assert.equal(pieceName(kinds, 'yt-scripts', 3), 'YT scripts')
  assert.equal(describeKind(kinds, 'yt-scripts'), 'a YT script')
  assert.equal(pieceName(DEFAULT_KINDS, 'essay', 2), 'essays')
})

test('a folder is a kind by its top-level folder, matched by name as it is on disk', () => {
  assert.equal(kindOfFolder(DEFAULT_KINDS, 'textbooks'), undefined)
  assert.equal(kindOfFolder(DEFAULT_KINDS, 'texts')?.id, 'text')
  assert.equal(kindOfFolder(DEFAULT_KINDS, 'Texts')?.id, 'text', 'any case')
  assert.equal(kindOfFolder(DEFAULT_KINDS, 'essays/2024/spring')?.id, 'essay', 'a subfolder is its top folder’s kind')
  assert.equal(kindOfFolder(DEFAULT_KINDS, 'emailsx'), undefined)
  assert.equal(kindOfFolder(DEFAULT_KINDS, ''), undefined)
  const hindi = newKind('ब्लॉग', [])!
  assert.equal(kindOfFolder([hindi], 'ब्लॉग'.normalize('NFD'))?.id, 'ब्लॉग')
})

test('a note’s kind comes from its folder; at the top of the vault it is Unfiled, whatever front matter says', () => {
  assert.equal(kindOfPath(DEFAULT_KINDS, 'essays/on-walking.md'), 'essay')
  assert.equal(kindOfPath(DEFAULT_KINDS, 'essays/2024/on-walking.md', {}, 'linkedin'), 'essay', 'the folder wins')
  assert.equal(kindOfPath(DEFAULT_KINDS, 'loose.md', {}, 'essay'), UNFILED)
  assert.equal(kindOfPath(DEFAULT_KINDS, 'loose.md'), '')
  // Set-apart folders aren't kinds: a template says which kind it's for; otherwise Unfiled.
  assert.equal(kindOfPath(DEFAULT_KINDS, 'templates/post.md', {}, 'linkedin'), 'linkedin')
  assert.equal(kindOfPath(DEFAULT_KINDS, 'templates/post.md', {}, 'no-such-kind'), '')
  assert.equal(kindOfPath(DEFAULT_KINDS, 'journal/today.md'), '')
  // The Brain holds sources, even when its folder sits in a kind's.
  const kinds = [...DEFAULT_KINDS, { id: 'note', name: 'Note', folder: 'Notes', guidance: '', words: 800 }]
  assert.equal(kindOfPath(kinds, 'Notes/brain/books/b.md', { brain: 'Notes/brain' }), '')
  assert.equal(kindOfPath(kinds, 'Notes/idea.md', { brain: 'Notes/brain' }), 'note')
  assert.equal(topFolder('essays/2024/a.md'), 'essays')
  assert.equal(topFolder('a.md'), '')
})

test('set-apart folders are never kinds', () => {
  for (const f of ['templates', 'Journal', 'brain', 'sources', 'exports', '_inbox', 'attachments', 'assets', 'ideas', 'trash', '.ekdanta', '.obsidian']) assert.ok(isSetApartFolder(f), f)
  assert.ok(isSetApartFolder('Archive', { excluded: ['archive/'] }))
  assert.ok(isSetApartFolder('Library', { brain: 'library' }))
  for (const f of ['essays', 'Book chapters', 'Letters', 'Notes', 'imported']) assert.ok(!isSetApartFolder(f), f)
  // A new kind never takes a set-apart folder.
  assert.equal(newKind('Attachment', [])?.folder, 'my-attachments')
  assert.equal(newKind('Template', [])?.folder, 'my-templates')
})

test('a kind’s name comes from its folder, and a renamed kind’s folder keeps its style', () => {
  assert.equal(nameFromFolder('Book chapters'), 'Book chapter')
  assert.equal(nameFromFolder('Letters'), 'Letter')
  assert.equal(nameFromFolder('notes'), 'Note')
  assert.equal(nameFromFolder('yt-scripts'), 'Yt script')
  assert.equal(nameFromFolder('Essays'), 'Essay')
  assert.equal(nameFromFolder('ब्लॉग'), 'ब्लॉग')
  assert.equal(folderForName('Short story', 'Book chapters'), 'Short stories')
  assert.equal(folderForName('YT short', 'yt-scripts'), 'yt-shorts')
  assert.equal(folderForName('Long essay', 'essays'), 'long-essays')
})

test('the kinds are the vault’s folders: saved settings carry over by folder, then by name', () => {
  const saved: Kind[] = [
    { ...DEFAULT_KINDS[0], guidance: 'my own essay rules' }, // essay, folder essays
    ...DEFAULT_KINDS.slice(1),
    { id: 'book-chapter', name: 'Book chapter', folder: 'book-chapters', guidance: 'one scene each', words: 4000 },
  ]
  const kinds = kindsFromFolders(saved, ['Essays', 'Book chapters', 'Letters', 'Notes'])
  // Saved ones first, in their order, then the new ones by folder name.
  assert.deepEqual(
    kinds.map((k) => `${k.id}:${k.folder}:${k.name}`),
    ['essay:Essays:Essay', 'book-chapter:Book chapters:Book chapter', 'letter:Letters:Letter', 'note:Notes:Note'],
  )
  assert.equal(kinds[0].guidance, 'my own essay rules', 'settings carry over when the folder matches')
  assert.equal(kinds[1].words, 4000)
  // Kinds whose folder isn't there aren't listed (no clutter), and come back with it.
  assert.ok(!kinds.some((k) => k.id === 'linkedin'))
  assert.equal(kindsFromFolders(saved, ['Essays', 'linkedin']).find((k) => k.id === 'linkedin')?.name, 'LinkedIn post')
  // An empty vault has no kinds: the built-in ones are only suggestions.
  assert.deepEqual(kindsFromFolders(saved, []), [])
  assert.deepEqual(
    suggestedKinds(kinds).map((k) => k.id),
    ['linkedin', 'email', 'text', 'blog', 'youtube-script'],
  )
  // A new folder never takes an id a saved kind has, even a hidden one.
  const taken = kindsFromFolders([{ id: 'note', name: 'Memo', folder: 'memos', guidance: '', words: 10 }], ['memos', 'Notes'])
  assert.deepEqual(
    taken.map((k) => `${k.id}:${k.folder}`),
    ['note:memos', 'note-2:Notes'],
  )
  // The same folder twice (in two cases) is one kind.
  assert.equal(kindsFromFolders([], ['Notes', 'notes']).length, 1)
})

test('Unfiled reads as Unfiled, and help never takes it for an essay', () => {
  assert.equal(kindName(DEFAULT_KINDS, ''), 'Unfiled')
  assert.equal(describeKind(DEFAULT_KINDS, ''), 'a piece of writing')
  assert.equal(describeKind(DEFAULT_KINDS, undefined), 'a piece of writing')
  assert.equal(describeKind(DEFAULT_KINDS, 'not-a-kind'), 'a piece of writing')
  assert.match(describeKind(DEFAULT_KINDS, 'essay'), /^an essay: /)
})
