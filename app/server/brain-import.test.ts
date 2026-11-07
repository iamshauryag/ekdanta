import test from 'node:test'
import assert from 'node:assert/strict'
import { parseClippings, parseHighlightsFile, parseReadwiseCsv } from './kindle.ts'
import {
  alreadyKept,
  cleanBrainFolder,
  escapeMd,
  findSame,
  formatLocation,
  isBrainPath,
  lookupKind,
  mergeHighlights,
  newSourceBody,
  normalizeUrl,
  parseHighlights,
  sameWork,
  unescapeMd,
  youtubeId,
} from '../src/lib/brain.ts'

const clip = (head: string, meta: string, text: string) => `${head}\n${meta}\n\n${text}\n==========\n`

const CLIPPINGS =
  '﻿' +
  clip(
    'Thinking, Fast and Slow (Kahneman, Daniel)',
    '- Your Highlight on page 12 | Location 180-182 | Added on Monday, 1 January 2024 10:00:00',
    'Nothing in life is as important as you think it is',
  ) +
  // The same passage, extended later: one highlight, the longer one.
  clip(
    'Thinking, Fast and Slow (Kahneman, Daniel)',
    '- Your Highlight on page 12 | Location 180-183 | Added on Monday, 1 January 2024 10:01:00',
    'Nothing in life is as important as you think it is, while you are thinking about it.',
  ) +
  clip('Thinking, Fast and Slow (Kahneman, Daniel)', '- Your Note on page 12 | Location 183 | Added on Monday, 1 January 2024 10:02:00', 'my own note') +
  clip('Thinking, Fast and Slow (Kahneman, Daniel)', '- Your Bookmark on page 40 | Location 600 | Added on Monday, 1 January 2024 10:03:00', '') +
  clip(
    'Thinking, Fast and Slow (Kahneman, Daniel)',
    '- Your Highlight on page 80 | Location 1234-1236 | Added on Tuesday, 2 January 2024 09:00:00',
    'A reliable way to make people believe in falsehoods is frequent repetition.',
  ) +
  clip('Bird by Bird (Anne Lamott)', '- Your Highlight at location 300-301 | Added on Wednesday, 3 January 2024 08:00:00', 'Almost all good writing begins with terrible first efforts.')

test('Kindle clippings: grouped by book, notes and bookmarks left out, extended highlights kept once', () => {
  const { books, skipped } = parseClippings(CLIPPINGS)
  assert.equal(skipped, 0)
  assert.deepEqual(
    books.map((b) => [b.title, b.author, b.highlights.length]),
    [
      ['Thinking, Fast and Slow', 'Kahneman, Daniel', 2],
      ['Bird by Bird', 'Anne Lamott', 1],
    ],
  )
  const [first, second] = books[0].highlights
  assert.equal(first.text, 'Nothing in life is as important as you think it is, while you are thinking about it.')
  assert.equal(first.location, 'loc 180')
  assert.equal(second.location, 'loc 1234')
  assert.equal(books[1].highlights[0].location, 'loc 300')
})

test('Kindle clippings in other languages, and entries that cannot be read', () => {
  const raw =
    clip('Der Process (Kafka, Franz)', '- Ihre Markierung bei Position 120-121 | Hinzugefügt am Montag, 1. Januar 2024 10:00:00', 'Jemand mußte Josef K. verleumdet haben.') +
    clip("L'Étranger (Camus, Albert)", '- Votre surlignement sur la page 5 | emplacement 77-78 | Ajouté le lundi 1 janvier 2024 10:00:00', "Aujourd'hui, maman est morte.") +
    clip(
      'Cien años de soledad (García Márquez, Gabriel)',
      '- Tu subrayado en la página 9 | posición 140-141 | Añadido el lunes, 1 de enero de 2024',
      'Muchos años después, frente al pelotón de fusilamiento.',
    ) +
    clip('Mystery (Someone)', '- ??? 12 | ???', 'unreadable meta') +
    'garbage without a meta line\n==========\n'
  const { books, skipped } = parseClippings(raw)
  assert.equal(books.length, 3)
  assert.deepEqual(
    books.map((b) => b.highlights[0].location),
    ['loc 120', 'loc 77', 'loc 140'],
  )
  assert.equal(skipped, 2)
})

test('Readwise CSV: rows grouped by book, locations kept, bad rows counted', () => {
  const csv = [
    'Highlight,Book Title,Book Author,Amazon Book ID,Note,Color,Tags,Location Type,Location,Highlighted at,Document tags',
    '"A reliable way to make people believe in falsehoods is frequent repetition, because familiarity is not easily distinguished from truth.",Thinking Fast and Slow,Daniel Kahneman,B00555X8OA,,yellow,,location,1234,2024-01-02 09:00:00+00:00,',
    '"He said, ""quote"" with a comma, inside",Bird by Bird,Anne Lamott,,,yellow,,page,22,,',
    ',Bird by Bird,Anne Lamott,,,,,,,,',
  ].join('\n')
  const { books, skipped } = parseReadwiseCsv(csv)
  assert.equal(skipped, 1)
  assert.equal(books.length, 2)
  assert.equal(books[0].highlights[0].location, 'loc 1234')
  assert.equal(books[1].highlights[0].text, 'He said, "quote" with a comma, inside')
  assert.equal(books[1].highlights[0].location, 'p. 22')
  assert.equal(parseHighlightsFile(csv).format, 'readwise')
  assert.equal(parseHighlightsFile(CLIPPINGS).format, 'kindle')
  assert.equal(parseHighlightsFile('just some text').format, null)
})

test('the same book from Kindle and Readwise is one work', () => {
  assert.equal(sameWork({ title: 'Thinking, Fast and Slow', author: 'Kahneman, Daniel' }, { title: 'Thinking Fast and Slow', author: 'Daniel Kahneman' }), true)
  assert.equal(sameWork({ title: 'Bird by Bird: Some Instructions on Writing and Life', author: 'Anne Lamott' }, { title: 'Bird by Bird', author: 'Lamott, Anne' }), true)
  assert.equal(sameWork({ title: 'Bird by Bird', author: 'Anne Lamott' }, { title: 'Bird by Bird', author: 'Someone Else' }), false)
  assert.equal(sameWork({ title: 'Walden', author: '' }, { title: 'Walden (Penguin Classics Edition)', author: 'Thoreau' }), true)
})

test('importing merges append-only, and again adds nothing', () => {
  const { books } = parseClippings(CLIPPINGS)
  const first = mergeHighlights(newSourceBody(), books[0].highlights)
  assert.equal(first.added, 2)
  assert.equal(parseHighlights(first.body).length, 2)
  const again = mergeHighlights(first.body, books[0].highlights)
  assert.equal(again.added, 0)
  assert.equal(again.body, first.body)
})

test('a highlight the writer edited is kept, and re-import does not duplicate it', () => {
  const base = newSourceBody([{ text: 'Nothing in life is as important as you think it is, while you are thinking about it.', location: 'loc 180' }])
  const edited = base.replace('thinking about it.', 'thinking about it!').replace('Nothing in life', 'Nothing in *life*')
  const { added, body } = mergeHighlights(edited, [{ text: 'Nothing in life is as important as you think it is, while you are thinking about it.', location: 'loc 180' }])
  assert.equal(added, 0)
  assert.equal(body, edited)
  // A trimmed one too.
  const trimmed = base.replace(', while you are thinking about it.', '.')
  assert.equal(mergeHighlights(trimmed, [{ text: 'Nothing in life is as important as you think it is, while you are thinking about it.', location: 'loc 180' }]).added, 0)
  // But a different passage at the same place is new.
  assert.equal(mergeHighlights(base, [{ text: 'Completely different words about elephants and tea.', location: 'loc 180' }]).added, 1)
})

test('writer text around the highlights is left alone', () => {
  const body = '## Summary\n\nMy summary.\n\n## Highlights\n\n> First one, long enough.\n— loc 1\n\nMy aside about it.\n\n## Later\n\nStays last.\n'
  const { body: out, added } = mergeHighlights(body, [{ text: 'Second one, also long enough.', location: 'loc 2' }])
  assert.equal(added, 1)
  assert.ok(out.startsWith('## Summary\n\nMy summary.\n\n## Highlights\n\n> First one, long enough.\n— loc 1\n\nMy aside about it.\n\n> Second one, also long enough.\n— loc 2\n'))
  assert.ok(out.endsWith('## Later\n\nStays last.\n'))
  assert.deepEqual(
    parseHighlights(out).map((h) => h.text),
    ['First one, long enough.', 'Second one, also long enough.'],
  )
  // A note with no Highlights section gets one.
  const bare = mergeHighlights('Just notes.\n', [{ text: 'A new highlight here.' }])
  assert.equal(bare.body, 'Just notes.\n\n## Highlights\n\n> A new highlight here.\n')
})

test("'>' and Markdown in a highlight are escaped inside the quote, and read back as written", () => {
  const text = '> not a quote\n# not a heading\n- not a list\n1. not a number\n*stars* and _under_ and [[link]] and <b>tag</b> and ==mark== and `code`'
  const body = newSourceBody([{ text, location: 'p. 3' }])
  const quoteLines = body.split('## Highlights\n')[1].trim().split('\n')
  assert.ok(
    quoteLines.slice(0, 5).every((l) => l.startsWith('> \\') || l.startsWith('> 1\\.') || l.startsWith('> \\*')),
    quoteLines.join('\n'),
  )
  assert.equal(quoteLines.at(-1), '— p. 3')
  assert.deepEqual(parseHighlights(body), [{ text, location: 'p. 3' }])
  assert.equal(unescapeMd(escapeMd(text)), text)
})

test('highlights read back however an editor saved them', () => {
  const inside = '## Highlights\n\n> A quote that is long enough here.\n> — loc 44\n'
  assert.deepEqual(parseHighlights(inside), [{ text: 'A quote that is long enough here.', location: 'loc 44' }])
  const runOn = '## Highlights\n\n> A quote that is long enough here. — [12:34](https://www.youtube.com/watch?v=abcdefghijk&t=754s)\n'
  assert.deepEqual(parseHighlights(runOn), [{ text: 'A quote that is long enough here.', location: '[12:34](https://www.youtube.com/watch?v=abcdefghijk&t=754s)' }])
  assert.deepEqual(parseHighlights('no section\n> quote\n'), [])
})

test('YouTube URLs: youtu.be, shorts and &t= variants are one video', () => {
  const plain = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  for (const u of [
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=42',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1m2s&feature=share',
    'https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
  ])
    assert.equal(normalizeUrl(u), plain, u)
  assert.equal(youtubeId('https://example.com/watch?v=dQw4w9WgXcQ'), null)
  assert.equal(normalizeUrl('http://www.Example.com/post/?utm_source=x&id=2#top'), 'https://example.com/post?id=2')
})

test('lookups: only http(s) URLs are fetched', () => {
  assert.equal(lookupKind('https://youtu.be/dQw4w9WgXcQ'), 'url')
  assert.equal(lookupKind('youtu.be/dQw4w9WgXcQ'), 'url')
  assert.equal(lookupKind('978-0-374-53355-7'), 'isbn')
  assert.equal(lookupKind('Thinking, Fast and Slow'), 'title')
  assert.equal(lookupKind('file:///etc/passwd'), 'refused')
  assert.equal(lookupKind('javascript:alert(1)'), 'refused')
  assert.equal(lookupKind('ftp://example.com/x'), 'refused')
  assert.equal(lookupKind('Note: a title with a colon'), 'title')
  assert.equal(lookupKind('  '), 'empty')
})

test('an existing source is found by ISBN, URL, or title and author', () => {
  const sources = [
    { path: 'brain/books/tfas.md', title: 'Thinking, Fast and Slow', author: 'Kahneman, Daniel', isbn: '9780374533557' },
    { path: 'brain/videos/v.md', title: 'A talk', author: 'Channel', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  ]
  assert.equal(findSame(sources, { isbn: '978-0-374-53355-7', title: 'whatever' })?.path, 'brain/books/tfas.md')
  assert.equal(findSame(sources, { url: 'https://youtu.be/dQw4w9WgXcQ?t=5', title: 'Other' })?.path, 'brain/videos/v.md')
  assert.equal(findSame(sources, { title: 'thinking fast and slow', author: 'Daniel Kahneman' })?.path, 'brain/books/tfas.md')
  assert.equal(findSame(sources, { title: 'Thinking, Fast and Slow', author: 'Someone Else' }), undefined)
})

test('locations as a writer types them', () => {
  assert.equal(formatLocation('1234', 'book'), 'loc 1234')
  assert.equal(formatLocation('p 12', 'book'), 'p. 12')
  assert.equal(formatLocation('page 12', 'article'), 'p. 12')
  assert.equal(formatLocation('12:34', 'video', 'https://youtu.be/dQw4w9WgXcQ'), '[12:34](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s)')
  assert.equal(formatLocation('1:02:03', 'podcast'), '1:02:03')
  assert.equal(formatLocation('', 'book'), '')
})

test('brain folder paths', () => {
  assert.equal(isBrainPath('brain/books/x.md'), true)
  assert.equal(isBrainPath('Brain/books/x.md'), true)
  assert.equal(isBrainPath('brainy/x.md'), false)
  assert.equal(isBrainPath('library/x.md', 'library'), true)
  assert.equal(isBrainPath('brain/x.md', 'library'), false)
  assert.equal(cleanBrainFolder(' /library/ '), 'library')
  assert.equal(cleanBrainFolder('../out'), '')
  assert.equal(cleanBrainFolder('.hidden'), '')
})

test('alreadyKept ignores empty highlights', () => {
  assert.equal(alreadyKept([], { text: '  ' }), true)
})
