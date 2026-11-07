// What a help key does with nothing selected, decided from where the caret is. Pure, so the whole
// behaviour matrix (see the table at the top of controller.ts) is tested without an editor.

export type Level = 1 | 2 | 3 | 4 | 5

/** The kind of block the caret is in. */
export type Block = 'paragraph' | 'heading' | 'listItem' | 'code' | 'table'

export interface Caret {
  block: Block
  /** The text of the caret's block. */
  text: string
  /** Only whitespace between the caret and the end of its block. */
  atEnd: boolean
  /** The word being typed: its letters before and after the caret (see wordAtCaret). */
  partial: string
  suffix: string
  /** Straight after a line break: a new line within the paragraph. */
  lineStart: boolean
  /** The nearest non-empty block before this one has text (for an empty line). */
  hasPrevious: boolean
  /** At least one sentence of the writer's own text in the body (see hasOwnSentence). */
  hasOwn: boolean
  title: string
}

/** Where generated text goes. */
export type Place =
  | 'inline' // at the caret, on the writer's line
  | 'wordEnd' // the caret is inside a word: move it to the word's end, then as 'inline'
  | 'paragraphStart' // at the caret, which starts an empty paragraph or list item, or a new line
  | 'afterHeading' // a new paragraph straight after the heading the caret is in
  | 'nextItem' // a new list item after the caret's

export type Plan =
  | { do: 'notice'; text: 'code' | 'table' | 'firstLine' }
  | { do: 'recall'; on: 'block' | 'previous' | 'title' }
  | { do: 'nudge'; on: 'block' | 'next' | 'opening' }
  | { do: 'questions' }
  | { do: 'word'; mode: 'next' | 'complete' | 'opener' }
  | { do: 'ghost'; place: Place; list: boolean }
  | { do: 'continue'; place: Place; list: boolean }
  | { do: 'bar'; hint: boolean }

/** Which help level a keydown asks for: ⌥1–⌥5 everywhere, ⌘1–⌘5 where the browser allows it. */
export function helpLevel(e: { code: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): Level | null {
  const m = e.code.match(/^Digit([1-5])$/)
  if (!m || e.shiftKey || e.ctrlKey) return null
  if (e.altKey !== e.metaKey) return Number(m[1]) as Level
  return null
}

/** What a help level does at the caret, with nothing selected. */
export function planCaret(level: Level, c: Caret, isComplete: (word: string) => boolean = () => false): Plan {
  if (c.block === 'code' || c.block === 'table') return { do: 'notice', text: c.block }
  const here = c.text.trim() !== ''
  const list = c.block === 'listItem'

  // Before the writer's first sentence: questions, never prose.
  if (!c.hasOwn) {
    if (level === 1) return here ? { do: 'recall', on: 'block' } : c.title.trim() ? { do: 'recall', on: 'title' } : { do: 'notice', text: 'firstLine' }
    if (!here && !c.title.trim()) return { do: 'notice', text: 'firstLine' }
    if (level === 2) return here ? { do: 'nudge', on: 'block' } : { do: 'nudge', on: 'opening' }
    return { do: 'questions' }
  }

  // An empty line (or empty list item) after the writer's text: what comes next.
  if (!here) {
    if (level === 1) return c.hasPrevious ? { do: 'recall', on: 'previous' } : c.title.trim() ? { do: 'recall', on: 'title' } : { do: 'notice', text: 'firstLine' }
    if (level === 2) return { do: 'nudge', on: 'next' }
    if (level === 3) return { do: 'word', mode: 'opener' }
    if (c.block === 'heading') return { do: level === 4 ? 'ghost' : 'continue', place: 'afterHeading', list: false }
    return { do: level === 4 ? 'ghost' : 'continue', place: 'paragraphStart', list }
  }

  if (level === 1) return { do: 'recall', on: 'block' }
  if (level === 2) return { do: 'nudge', on: 'block' }
  // Straight after a line break, new text starts the line: capitalised, never joined onto the line above.
  if (c.lineStart && !list && c.block === 'paragraph') {
    if (level === 3) return { do: 'word', mode: 'opener' }
    if (level === 4 || c.atEnd) return { do: level === 4 ? 'ghost' : 'continue', place: 'paragraphStart', list: false }
    return { do: 'bar', hint: true }
  }
  if (level === 3) {
    // Inside a word, or after one that may be unfinished: finish it. After a short, complete word: the next one.
    if (c.partial && (c.suffix || !isComplete(c.partial))) return { do: 'word', mode: 'complete' }
    return { do: 'word', mode: 'next' }
  }
  // A heading's section and a list's next item come after the block, wherever the caret is in it.
  if (c.block === 'heading') return { do: level === 4 ? 'ghost' : 'continue', place: 'afterHeading', list: false }
  if (list) return { do: level === 4 ? 'ghost' : 'continue', place: 'nextItem', list: true }
  // Inside a word ("writ|ing"), a sentence never splits it: it goes after the whole word.
  if (level === 4) return { do: 'ghost', place: c.suffix ? 'wordEnd' : 'inline', list: false }
  // ⌘5 continues a paragraph from its end; elsewhere it rewrites, as it always has.
  return c.atEnd && !c.suffix ? { do: 'continue', place: 'inline', list: false } : { do: 'bar', hint: true }
}

/** The local server didn't answer at all (as opposed to a model failing behind it). */
export const SERVER_DOWN = 'ekdanta-server-down'

const PROVIDERS: Record<string, string> = { ollama: 'Ollama', 'claude-cli': 'Claude CLI', 'anthropic-api': 'the Anthropic API' }

/** An error as the writer should read it, naming the provider actually in use. */
export function friendlyError(msg: string, provider?: string | null) {
  if (msg === SERVER_DOWN) return 'Ekdanta’s server isn’t running · start it with `npm run dev`'
  const name = provider ? PROVIDERS[provider] : undefined
  if (/No model/i.test(msg)) return msg
  if (/rejected/i.test(msg)) return 'Your API key was rejected'
  if (/timed out/i.test(msg)) return `${name ?? 'The model'} took too long · try again`
  // The model answered, but not in a form we could use: not a connection problem.
  if (/JSON|Unexpected token/i.test(msg)) return `${name ?? 'The model'} gave an answer that couldn’t be read · try again`
  if (/rate.?limit|usage limit|overloaded|\b429\b|\b529\b/i.test(msg)) return `${name ?? 'The model'} is busy or at its limit · try again shortly`
  if (provider === 'ollama' || (!name && /Ollama/i.test(msg))) return 'Couldn’t reach Ollama · start it with `ollama serve`'
  // Install and sign-in advice only when the CLI couldn't start or isn't signed in; any other failure
  // is the CLI's own answer, said as it is.
  if (provider === 'claude-cli') {
    if (/ENOENT|spawn|session ended|not available|log ?in|logged|auth|credential/i.test(msg)) return `Couldn’t reach Claude CLI · check that \`claude\` is installed and signed in`
    return `Claude CLI couldn’t answer · ${msg.slice(0, 80)}`
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(msg)) return `Couldn’t reach ${name ?? 'the model'} · check your connection`
  return `Something went wrong · ${msg.slice(0, 80)}`
}
