// How the page looks and where new notes go: the Appearance, Writing and Vault settings that are
// plain values. The server cleans them with these rules before saving (settings.json is a file the
// writer can edit), and the app turns them into CSS custom properties. Shared, so no DOM here.
import type { Kind } from './kinds.ts'

export const FONTS = ['serif', 'sans', 'mono', 'system', 'custom'] as const
export const LINE_WIDTHS = ['narrow', 'comfortable', 'wide', 'full'] as const
export const LINE_HEIGHTS = ['compact', 'normal', 'airy'] as const
export const SPACINGS = ['none', 'half', 'line'] as const
export const VIEWS = ['page', 'markdown'] as const
export const NEW_NOTES = ['kind', 'current', 'fixed'] as const

export type Font = (typeof FONTS)[number]
export type LineWidth = (typeof LINE_WIDTHS)[number]
export type LineHeight = (typeof LINE_HEIGHTS)[number]
export type Spacing = (typeof SPACINGS)[number]
export type DocView = (typeof VIEWS)[number]
export type NewNotes = (typeof NEW_NOTES)[number]

export interface Appearance {
  font: Font
  /** A font family the writer names, used when `font` is 'custom'. */
  fontFamily: string
  /** The page's text size in px. */
  textSize: number
  lineWidth: LineWidth
  lineHeight: LineHeight
  paragraphSpacing: Spacing
  wordCount: boolean
  spellcheck: boolean
  /** Which view a new document opens in. */
  newDocView: DocView
  /** How long after the last keystroke a document saves, in ms. */
  autosaveMs: number
  /** Start on the document that was open last; otherwise on a fresh draft. */
  openLast: boolean
  newNotesIn: NewNotes
  /** The folder new notes go in when `newNotesIn` is 'fixed' ('' is the top of the vault). */
  newNotesFolder: string
  /** A vault-relative .css file whose rules are added to the app, as Obsidian's snippets are. */
  cssSnippet: string
  /** Show the power options in every Settings tab. */
  showAdvanced: boolean
}

export const TEXT_SIZE = { min: 14, max: 22, step: 0.5 }
export const AUTOSAVE = { min: 400, max: 3000, step: 100 }

export const APPEARANCE_DEFAULTS: Appearance = {
  font: 'serif',
  fontFamily: '',
  textSize: 18.5,
  lineWidth: 'comfortable',
  lineHeight: 'normal',
  paragraphSpacing: 'half',
  wordCount: true,
  spellcheck: true,
  newDocView: 'page',
  autosaveMs: 800,
  openLast: true,
  newNotesIn: 'current',
  newNotesFolder: '',
  cssSnippet: '',
  showAdvanced: false,
}

const STACKS: Record<Exclude<Font, 'custom'>, string> = {
  serif: 'var(--serif)',
  sans: 'var(--sans)',
  mono: 'var(--mono)',
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
}
// Measured in rem, so the column keeps its width when the text size changes. 40rem is the old 640px.
const MEASURES: Record<Exclude<LineWidth, 'full'>, string> = { narrow: '34rem', comfortable: '40rem', wide: '48rem' }
const LEADING: Record<LineHeight, string> = { compact: '1.4', normal: '1.6', airy: '1.85' }
// Space between paragraphs, in lines of the page's own leading. Half a line is the default, so a new
// paragraph reads differently from a line break inside one; None sets them alike.
const GAPS: Record<Spacing, string> = { none: '0', half: 'calc(var(--page-leading) * 0.5em)', line: 'calc(var(--page-leading) * 1em)' }

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)
const clamp = (v: unknown, lo: number, hi: number, step: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.max(lo, Math.min(hi, Math.round(n / step) * step))
}

/** A font family name as the writer typed it, made safe to put in a CSS value: no quotes, braces or semicolons. */
export function cleanFamily(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v
    .replace(/["'`;{}()<>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** A vault-relative folder ('' for the top), or null when it isn't one we'd write into. */
export function cleanFolder(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const f = v
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim()
  if (f.length > 200 || (f && f.split('/').some((part) => !part.trim() || part.startsWith('.')))) return null
  return f
}

/** A vault-relative path to a .css file, or '' when it isn't one. */
export function cleanSnippet(v: unknown): string {
  const f = cleanFolder(v)
  return f && /\.css$/i.test(f) ? f : ''
}

/** Every appearance value, valid: anything missing, of the wrong type or out of range takes its default. */
export function cleanAppearance(saved: Partial<Record<keyof Appearance, unknown>>): Appearance {
  const d = APPEARANCE_DEFAULTS
  const bool = (k: keyof Appearance) => (typeof saved[k] === 'boolean' ? (saved[k] as boolean) : (d[k] as boolean))
  const fontFamily = cleanFamily(saved.fontFamily)
  let font = oneOf(FONTS, saved.font, d.font)
  if (font === 'custom' && !fontFamily) font = d.font
  return {
    font,
    fontFamily,
    textSize: clamp(saved.textSize, TEXT_SIZE.min, TEXT_SIZE.max, TEXT_SIZE.step, d.textSize),
    lineWidth: oneOf(LINE_WIDTHS, saved.lineWidth, d.lineWidth),
    lineHeight: oneOf(LINE_HEIGHTS, saved.lineHeight, d.lineHeight),
    paragraphSpacing: oneOf(SPACINGS, saved.paragraphSpacing, d.paragraphSpacing),
    wordCount: bool('wordCount'),
    spellcheck: bool('spellcheck'),
    newDocView: oneOf(VIEWS, saved.newDocView, d.newDocView),
    autosaveMs: clamp(saved.autosaveMs, AUTOSAVE.min, AUTOSAVE.max, AUTOSAVE.step, d.autosaveMs),
    openLast: bool('openLast'),
    newNotesIn: oneOf(NEW_NOTES, saved.newNotesIn, d.newNotesIn),
    newNotesFolder: cleanFolder(saved.newNotesFolder) ?? '',
    cssSnippet: cleanSnippet(saved.cssSnippet),
    showAdvanced: bool('showAdvanced'),
  }
}

/** The font stack for the page. A named family that isn't installed falls through to the serif stack. */
export function fontStack(a: Pick<Appearance, 'font' | 'fontFamily'>): string {
  if (a.font === 'custom') {
    const family = cleanFamily(a.fontFamily)
    return family ? `"${family}", var(--serif)` : STACKS.serif
  }
  return STACKS[a.font] ?? STACKS.serif
}

/** The CSS custom properties that carry the appearance settings, set on :root. 'Full' width is a data attribute instead. */
export function appearanceVars(a: Appearance): Record<string, string> {
  return {
    '--page-font': fontStack(a),
    '--page-size': `${a.textSize}px`,
    '--page-leading': LEADING[a.lineHeight],
    '--para-gap': GAPS[a.paragraphSpacing],
    '--measure': a.lineWidth === 'full' ? MEASURES.comfortable : MEASURES[a.lineWidth],
  }
}

/**
 * Where a new note goes. 'kind': the folder of the kind being written now (the open piece's kind, or
 * the first kind); 'current': the open document's folder; 'fixed': the chosen folder.
 */
export function newNoteFolder(a: Pick<Appearance, 'newNotesIn' | 'newNotesFolder'>, ctx: { currentFolder: string; platform?: string; kinds: readonly Kind[] }): string {
  if (a.newNotesIn === 'fixed') return cleanFolder(a.newNotesFolder) ?? ''
  if (a.newNotesIn === 'kind') {
    const kind = ctx.kinds.find((k) => k.id === ctx.platform) ?? ctx.kinds[0]
    return kind?.folder ?? ctx.currentFolder
  }
  return ctx.currentFolder
}

/** The kinds whose folder an excluded folder covers: their voice profiles will have nothing to learn from. */
export function kindsInExcluded(kinds: readonly Kind[], excluded: readonly string[]): Kind[] {
  const norm = (f: string) => f.toLowerCase().replace(/^\/+|\/+$/g, '')
  return kinds.filter((k) => excluded.some((e) => norm(k.folder) === norm(e) || norm(k.folder).startsWith(norm(e) + '/')))
}

/** What the settings search needs to know about a row. */
export interface Searchable {
  tab: string
  id: string
  label: string
  keywords?: string
}

/**
 * Rows that match a query, best first: every word of the query must start a word of the row's label,
 * keywords or tab. Rows whose label matches come before rows found only by a keyword.
 */
export function searchRows<T extends Searchable>(rows: readonly T[], tabLabel: (tab: string) => string, query: string): T[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const tokens = (s: string) =>
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  const scored: { row: T; score: number; i: number }[] = []
  rows.forEach((row, i) => {
    const label = tokens(row.label)
    const rest = [...tokens(row.keywords ?? ''), ...tokens(tabLabel(row.tab))]
    let score = 0
    for (const w of words) {
      if (label.some((t) => t.startsWith(w))) score += 2
      else if (rest.some((t) => t.startsWith(w))) score += 1
      else return
    }
    scored.push({ row, score, i })
  })
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.row)
}
