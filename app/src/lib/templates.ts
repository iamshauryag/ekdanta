// Templates: Markdown files in the vault's templates/ folder (as in Obsidian's core Templates plugin).
// A template's front matter may say which kind it is for (`template-for: linkedin`) and what it's
// called (`template-name: LinkedIn post`); its other keys are copied into the new piece. Its text may
// use {{title}}, {{date}}, {{date:FORMAT}}, {{time}}, {{kind}}, {{author}} and {{cursor}}.
// Shared by the app and the server, so no DOM here.
import { joinFrontMatter, splitFrontMatter, type Meta } from './frontmatter.ts'
import type { Kind } from './kinds.ts'

export interface TemplateInfo {
  /** Vault-relative path: `templates/linkedin-post.md`. */
  path: string
  name: string
  /** The kind it's for (a kind id), or '' for any kind. */
  kind: string
}

export interface TemplateContext {
  /** The piece's title, or '' when it has none yet ({{title}} is then left for the first title). */
  title: string
  /** The kind's name, for {{kind}}. */
  kind: string
  /** The writer's name, for {{author}}, or ''. */
  author: string
  now: Date
}

/** Front-matter keys that describe the template itself, or that every new piece makes for itself. */
const NOT_COPIED = ['template-for', 'template-name', 'title', 'created', 'platform']

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number) => String(n).padStart(2, '0')

/**
 * A date in Moment's notation, as Obsidian's templates write it: `YYYY-MM-DD`, `MMMM D, YYYY`,
 * `D MMMM YYYY`, `dddd`, `HH:mm`, `h:mm A`. Text in [brackets] is kept as it is.
 */
export function formatDate(d: Date, format: string): string {
  const h12 = d.getHours() % 12 || 12
  const tokens: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MMMM: MONTHS[d.getMonth()],
    MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad(d.getDate()),
    D: String(d.getDate()),
    dddd: DAYS[d.getDay()],
    ddd: DAYS[d.getDay()].slice(0, 3),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    hh: pad(h12),
    h: String(h12),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    A: d.getHours() < 12 ? 'AM' : 'PM',
    a: d.getHours() < 12 ? 'am' : 'pm',
  }
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a/g, (m, literal?: string) => literal ?? tokens[m])
}

const CURSOR = '\u0000cursor\u0000'

/** Fill in one stretch of text (never inside Templater's <% … %>, which is left for Templater). */
function fill(text: string, ctx: TemplateContext): string {
  // The writer's name on a line of its own, when there's no name to give: ask for it instead.
  if (!ctx.author.trim()) text = text.replace(/^([ \t]*)\{\{\s*author\s*\}\}[ \t]*$/gim, '$1*Prompt: Your name*')
  return text.replace(/\{\{\s*([a-z]+)\s*(?::([^}]*))?\}\}/gi, (whole, name: string, format: string | undefined) => {
    switch (name.toLowerCase()) {
      case 'title':
        return ctx.title.trim() || whole
      case 'date':
        return formatDate(ctx.now, format?.trim() || 'YYYY-MM-DD')
      case 'time':
        return formatDate(ctx.now, format?.trim() || 'HH:mm')
      case 'kind':
        return ctx.kind
      case 'author':
        return ctx.author.trim()
      case 'cursor':
        return CURSOR
      default:
        return whole // someone else's variable: left as written
    }
  })
}

/**
 * A template's text with its variables filled in, and where {{cursor}} was (an offset into the
 * result, or null). Only the first {{cursor}} counts; any others are just removed.
 */
export function renderTemplate(text: string, ctx: TemplateContext): { text: string; cursor: number | null } {
  const out = text
    .split(/(<%[\s\S]*?%>)/)
    .map((part, i) => (i % 2 ? part : fill(part, ctx)))
    .join('')
  const at = out.indexOf(CURSOR)
  return { text: out.split(CURSOR).join(''), cursor: at < 0 ? null : at }
}

/** The writer's name for {{author}}, from a profile setting if there is one (another part of Settings may add it). */
export function authorOf(settings: object | null | undefined): string {
  const s = (settings ?? {}) as Record<string, unknown>
  for (const key of ['author', 'name', 'profileName']) if (typeof s[key] === 'string' && (s[key] as string).trim()) return (s[key] as string).trim()
  const you = s.you as Record<string, unknown> | undefined
  return typeof you?.name === 'string' ? you.name.trim() : ''
}

/** What a template file says about itself. */
export function templateInfo(path: string, content: string): TemplateInfo {
  const { meta } = splitFrontMatter(content)
  const file = path.split('/').pop()!.replace(/\.md$/i, '')
  const name = meta['template-name']?.trim() || meta.title?.trim() || file.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
  // A page made in templates/ through Ekdanta carries a platform; Obsidian templates may say template-for.
  const kind = (meta['template-for'] || meta.platform || '').trim().toLowerCase()
  return { path, name, kind }
}

/** The template's text for inserting into a piece: no front matter, variables filled in. */
export function templateBody(content: string, ctx: TemplateContext) {
  const { body } = splitFrontMatter(content)
  return renderTemplate(body.replace(/^\n+/, ''), ctx)
}

/** The front-matter keys a template passes on to a new piece, filled in. Its own keys are left behind. */
export function templateMeta(template: string, ctx: TemplateContext): Meta {
  const { meta } = splitFrontMatter(template)
  const out: Meta = {}
  for (const [key, value] of Object.entries(meta)) {
    if (NOT_COPIED.includes(key.toLowerCase())) continue
    out[key] = renderTemplate(value, ctx).text
  }
  return out
}

/**
 * A new piece made from a template: the piece keeps its own title, created date and kind; the
 * template's other front-matter keys are added (filled in), and its body becomes the piece's body.
 * `cursor` is an offset into the body, as splitFrontMatter reads it back.
 */
export function applyTemplate(doc: string, template: string, ctx: TemplateContext): { content: string; cursor: number | null } {
  const d = splitFrontMatter(doc)
  const meta: Meta = { ...d.meta, ...templateMeta(template, ctx) }
  const body = templateBody(template, ctx)
  return { content: joinFrontMatter(d.raw, meta, body.text), cursor: body.cursor }
}

export interface TemplateGroup {
  label: string
  items: TemplateInfo[]
}

/** Templates by the kind they're for, in the order of the kinds; then those for any kind; then those for a kind that's gone. */
export function groupTemplates(templates: TemplateInfo[], kinds: Kind[]): TemplateGroup[] {
  const groups: TemplateGroup[] = kinds.map((k) => ({ label: k.name, items: templates.filter((t) => t.kind === k.id) }))
  groups.push({ label: 'Any kind', items: templates.filter((t) => !t.kind) })
  groups.push({ label: 'Other', items: templates.filter((t) => t.kind && !kinds.some((k) => k.id === t.kind)) })
  return groups.filter((g) => g.items.length)
}

/**
 * How well a query matches a name: its letters in order, scored higher for matches at word starts
 * and in runs. 0 means no match; an empty query matches everything.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '')
  const t = text.toLowerCase()
  if (!q) return 1
  let score = 0
  let at = 0
  let prev = -2
  for (const ch of q) {
    const i = t.indexOf(ch, at)
    if (i < 0) return 0
    score += 1 + (i === prev + 1 ? 2 : 0) + (i === 0 || /[\s\-_/(]/.test(t[i - 1]) ? 3 : 0)
    prev = i
    at = i + 1
  }
  return score + (t.startsWith(q) ? 5 : 0)
}
