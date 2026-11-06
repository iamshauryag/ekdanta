import test from 'node:test'
import assert from 'node:assert/strict'
import { SPECIAL_FOLDERS, isPromptParagraph, isSpecialPath } from './special.ts'

test('special folders count at the top of the vault only', () => {
  for (const f of SPECIAL_FOLDERS) assert.equal(isSpecialPath(`${f}/x.md`), true, f)
  assert.equal(isSpecialPath('templates'), true)
  assert.equal(isSpecialPath('Templates/Essay.md'), true)
  assert.equal(isSpecialPath('/journal/2026-11-06.md'), true)
  assert.equal(isSpecialPath('essays/templates/x.md'), false)
  assert.equal(isSpecialPath('essays/x.md'), false)
  assert.equal(isSpecialPath('templates-old/x.md'), false)
  assert.equal(isSpecialPath('my-templates.md'), false)
  assert.equal(isSpecialPath(''), false)
})

test('excluded folders match whole names, nested or not', () => {
  const ex = ['archive', 'essays/drafts/', ' ']
  assert.equal(isSpecialPath('archive/a.md', ex), true)
  assert.equal(isSpecialPath('Archive/2019/a.md', ex), true)
  assert.equal(isSpecialPath('archived/a.md', ex), false)
  assert.equal(isSpecialPath('essays/drafts/a.md', ex), true)
  assert.equal(isSpecialPath('essays/drafts-2/a.md', ex), false)
  assert.equal(isSpecialPath('essays/a.md', ex), false)
  assert.equal(isSpecialPath('essays\\drafts\\a.md', ex), true)
  // Junk in settings is ignored rather than matching everything.
  assert.equal(isSpecialPath('essays/a.md', ['', '/', 3 as unknown as string]), false)
})

test('prompt paragraphs are only an italic Prompt: line', () => {
  assert.equal(isPromptParagraph('*Prompt: What happened first?*'), true)
  assert.equal(isPromptParagraph('  _Prompt: Under 1,300 characters_\n'), true)
  assert.equal(isPromptParagraph('*prompt: lower case still counts*'), true)
  assert.equal(isPromptParagraph('*Prompt: spans\ntwo lines*'), true)
  assert.equal(isPromptParagraph('*Prompt: one* and then my own words'), false)
  assert.equal(isPromptParagraph('Prompt: not italic'), false)
  assert.equal(isPromptParagraph('**Prompt: bold**'), false)
  assert.equal(isPromptParagraph('*Prompt: mixed_'), false)
  assert.equal(isPromptParagraph('*A prompt: no*'), false)
  assert.equal(isPromptParagraph(''), false)
})
