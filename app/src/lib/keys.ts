// Every remappable shortcut, in one place. Bindings use CodeMirror's notation ("Mod-Shift-b": ⌘⇧B on a
// Mac, Ctrl+Shift+B elsewhere). The writer's changes are saved in settings; anything unchanged follows
// the defaults here. The help ladder's own keys (⌘1–⌘5, Tab, Esc, ⌘↵) aren't remapped here.

export type Group = 'Text' | 'Blocks' | 'Editing' | 'Navigate' | 'App'

export interface Command {
  id: string
  label: string
  group: Group
  /** The default binding, or '' for none. */
  key: string
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const COMMAND_LIST = [
  { id: 'bold', label: 'Bold', group: 'Text', key: 'Mod-b' },
  { id: 'italic', label: 'Italic', group: 'Text', key: 'Mod-i' },
  { id: 'underline', label: 'Underline', group: 'Text', key: 'Mod-u' },
  { id: 'strike', label: 'Strikethrough', group: 'Text', key: 'Mod-Shift-x' },
  { id: 'highlight', label: 'Highlight', group: 'Text', key: 'Mod-Shift-h' },
  { id: 'code', label: 'Inline code', group: 'Text', key: 'Mod-e' },
  { id: 'link', label: 'Link', group: 'Text', key: 'Mod-k' },
  { id: 'clear', label: 'Clear formatting', group: 'Text', key: '' },

  { id: 'p', label: 'Normal text', group: 'Blocks', key: 'Mod-Shift-0' },
  { id: 'h1', label: 'Heading 1', group: 'Blocks', key: 'Mod-Shift-1' },
  { id: 'h2', label: 'Heading 2', group: 'Blocks', key: 'Mod-Shift-2' },
  { id: 'h3', label: 'Heading 3', group: 'Blocks', key: 'Mod-Shift-3' },
  { id: 'quote', label: 'Quote', group: 'Blocks', key: '' },
  { id: 'codeblock', label: 'Code block', group: 'Blocks', key: '' },
  { id: 'number', label: 'Numbered list', group: 'Blocks', key: 'Mod-Shift-7' },
  { id: 'bullet', label: 'Bulleted list', group: 'Blocks', key: 'Mod-Shift-8' },
  { id: 'todo', label: 'Checklist', group: 'Blocks', key: 'Mod-Shift-9' },
  { id: 'task', label: 'Tick or untick a to-do', group: 'Blocks', key: 'Mod-Enter' },
  { id: 'indent', label: 'Increase indent', group: 'Blocks', key: 'Mod-]' },
  { id: 'outdent', label: 'Decrease indent', group: 'Blocks', key: 'Mod-[' },

  { id: 'find', label: 'Find and replace', group: 'Editing', key: 'Mod-f' },
  { id: 'save', label: 'Save now', group: 'Editing', key: 'Mod-s' },

  { id: 'newDraft', label: 'New draft', group: 'App', key: 'Alt-n' },
  { id: 'thinking', label: 'Thinking Space', group: 'App', key: 'Alt-t' },
  { id: 'star', label: 'Star as exemplar', group: 'App', key: 'Alt-Shift-8' },
  { id: 'focus', label: 'Focus mode', group: 'App', key: 'Mod-.' },
  { id: 'panel', label: 'Right panel', group: 'App', key: 'Mod-\\' },
  { id: 'material', label: 'Panel: Material', group: 'App', key: 'Ctrl-Alt-1' },
  { id: 'outline', label: 'Panel: Outline', group: 'App', key: 'Ctrl-Alt-2' },
  { id: 'history', label: 'Panel: History', group: 'App', key: 'Ctrl-Alt-3' },
  { id: 'piece', label: 'Panel: Piece', group: 'App', key: 'Ctrl-Alt-4' },
  { id: 'settings', label: 'Settings', group: 'App', key: 'Alt-,' },
  // ⌘⇧I on a Mac; elsewhere Ctrl+Shift+I opens the browser's developer tools, so Ctrl+Alt+I.
  { id: 'captureIdea', label: 'Capture idea', group: 'App', key: isMac ? 'Mod-Shift-i' : 'Mod-Alt-i' },
  { id: 'ideas', label: 'Ideas', group: 'App', key: '' },
] as const satisfies readonly Command[]

export const COMMANDS: Command[] = [...COMMAND_LIST]
/** Every command's id, so a typo in App's action map is a type error. */
export type CommandId = (typeof COMMAND_LIST)[number]['id']

// ---- The bindings in use: defaults, with the writer's changes on top ----------------------------

let overrides: Record<string, string> = {}
const listeners = new Set<() => void>()

export function setOverrides(next: Record<string, string> | undefined) {
  overrides = { ...(next ?? {}) }
  listeners.forEach((l) => l())
}
export function onBindingsChange(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const defaultKey = (id: string) => COMMANDS.find((c) => c.id === id)?.key ?? ''
export const binding = (id: string) => (id in overrides ? overrides[id] : defaultKey(id))
export const bindings = () => Object.fromEntries(COMMANDS.map((c) => [c.id, binding(c.id)]))

// ---- Reading and showing keys -------------------------------------------------------------

const CODE_KEYS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
}

/** The key that was pressed, named the same way whatever the keyboard layout or modifiers (⌥ changes e.key on a Mac). */
function baseKey(e: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5)
  if (/^F\d+$/.test(e.code)) return e.code
  return CODE_KEYS[e.code] ?? null
}

/** A key press as a binding ("Mod-Shift-b"), or null for a bare modifier. */
export function eventToKey(e: KeyboardEvent): string | null {
  const key = baseKey(e)
  if (!key) return null
  const mod = isMac ? e.metaKey : e.ctrlKey
  const ctrl = isMac && e.ctrlKey
  return [mod && 'Mod', ctrl && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('-')
}

/** The same binding written in a standard order, so two spellings of one key compare equal. */
export function normalize(key: string): string {
  if (!key) return ''
  const parts = key.split(/-(?!$)/)
  const base = parts.pop()!
  const has = (m: string) => parts.some((p) => p.toLowerCase() === m.toLowerCase() || (m === 'Mod' && p === (isMac ? 'Cmd' : 'Ctrl')))
  const out = [has('Mod') && 'Mod', isMac && has('Ctrl') && 'Ctrl', has('Alt') && 'Alt', has('Shift') && 'Shift', base.length === 1 ? base.toLowerCase() : base]
  return out.filter(Boolean).join('-')
}

export const matches = (e: KeyboardEvent, key: string) => !!key && eventToKey(e) === normalize(key)

const SYMBOLS: Record<string, string> = { Enter: '↵', Backspace: '⌫', Delete: '⌦', Escape: 'Esc', Tab: '⇥', Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }

/** "Mod-Shift-b" → "⌘⇧B" on a Mac, "Ctrl+Shift+B" elsewhere. */
export function formatKey(key: string): string {
  if (!key) return ''
  const parts = normalize(key).split(/-(?!$)/)
  const base = parts.pop()!
  const name = SYMBOLS[base] ?? base.toUpperCase()
  if (isMac) {
    const sym: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' }
    // Apple's order: ⌃ ⌥ ⇧ ⌘.
    return (
      ['Ctrl', 'Alt', 'Shift', 'Mod']
        .filter((m) => parts.includes(m))
        .map((m) => sym[m])
        .join('') + name
    )
  }
  const word: Record<string, string> = { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
  return [...['Mod', 'Alt', 'Shift'].filter((m) => parts.includes(m)).map((m) => word[m]), name].join('+')
}

/** A label with its shortcut, for tooltips: "Bold  ⌘B". */
export const titled = (label: string, id: string) => (binding(id) ? `${label}  ${formatKey(binding(id))}` : label)

// ---- Keys the system or browser keeps -------------------------------------------------------

const RESERVED_MAC: Record<string, string> = {
  'Mod-Shift-3': 'macOS screenshot',
  'Mod-Shift-4': 'macOS screenshot',
  'Mod-Shift-5': 'macOS screenshot tools',
  'Mod-q': 'quits the browser',
  'Mod-w': 'closes the tab',
  'Mod-t': 'opens a browser tab',
  'Mod-n': 'opens a browser window',
  'Mod-h': 'hides the app',
  'Mod-m': 'minimises the window',
  'Mod-Space': 'Spotlight',
  'Mod-Tab': 'switches apps',
  'Mod-l': 'the address bar',
  'Mod-r': 'reloads the page',
  'Mod-Shift-t': 'reopens a closed tab',
  'Mod-p': 'prints the page',
}
const RESERVED_OTHER: Record<string, string> = {
  'Mod-Shift-i': 'opens developer tools',
  'Mod-Shift-j': 'opens developer tools',
  'Mod-w': 'closes the tab',
  'Mod-t': 'opens a browser tab',
  'Mod-n': 'opens a browser window',
  'Mod-l': 'the address bar',
  'Mod-r': 'reloads the page',
  'Mod-Shift-t': 'reopens a closed tab',
  'Alt-F4': 'closes the window',
  'Mod-p': 'prints the page',
}

/** Why a key won't reach Ekdanta, if the system or the browser keeps it. */
export function reserved(key: string): string | undefined {
  const k = normalize(key)
  if (/^Mod-[1-5]$/.test(k) || /^Alt-[1-5]$/.test(k)) return 'used by the help ladder'
  if (/^Mod-[6-9]$/.test(k)) return 'switches browser tabs'
  return (isMac ? RESERVED_MAC : RESERVED_OTHER)[k]
}

/** Which other command already uses a key. */
export function usedBy(key: string, except: string): Command | undefined {
  const k = normalize(key)
  return k ? COMMANDS.find((c) => c.id !== except && normalize(binding(c.id)) === k) : undefined
}
