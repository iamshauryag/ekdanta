// The built-in Word engine, for when pandoc isn't installed: walks the prepared Markdown's tokens and
// builds the .docx with the `docx` package. It covers what the editor can make: headings, paragraphs,
// bold, italic, underline, strike, highlight, code, links, lists and to-dos, quotes, tables, images.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx'
import type Token from 'markdown-it/lib/token.mjs'
import { tokenizer } from '../src/editor/markdown.ts'
import type { Prepared } from '../src/lib/plaintext.ts'

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
const MONO = 'Courier New'
/** The widest an image may be: the text width of a Letter or A4 page with 1" margins, in pixels at 96 dpi. */
const MAX_WIDTH = 600

interface Marks {
  bold?: boolean
  italics?: boolean
  underline?: boolean
  strike?: boolean
  highlight?: boolean
  code?: boolean
}

type Block = Paragraph | Table

/** Width and height of a PNG, JPEG or GIF, read from its header; null if it isn't one of those. */
export function imageSize(data: Buffer): { type: 'png' | 'jpg' | 'gif'; width: number; height: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) return { type: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  if (data.length > 10 && data.toString('latin1', 0, 3) === 'GIF') return { type: 'gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null
      const marker = data[i + 1]
      const len = data.readUInt16BE(i + 2)
      // Start-of-frame markers carry the size (not DHT c4, JPG c8 or DAC cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: 'jpg', height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) }
      i += 2 + len
    }
  }
  return null
}

/** Build a .docx from a prepared document. Images are read from the absolute paths prepare() gave them. */
export async function builtinDocx(p: Prepared): Promise<{ data: Buffer; warnings: string[] }> {
  const tokens = tokenizer().parse(p.body, {})
  const warnings = new Set<string>()
  // Read every image up front, so the walk below can stay synchronous.
  const images = new Map<string, Buffer | null>()
  for (const t of tokens)
    for (const c of t.children ?? [])
      if (c.type === 'image') {
        const src = c.attrGet('src') ?? ''
        // markdown-it percent-encodes a destination; the file name is the decoded one.
        if (!images.has(src)) images.set(src, path.isAbsolute(decoded(src)) ? await fs.readFile(decoded(src)).catch(() => null) : null)
      }
  let lists = 0 // each numbered list restarts at its own number

  const runs = (t: Token | undefined): ParagraphChild[] => {
    const out: ParagraphChild[] = []
    const marks: Marks = {}
    let link: { href: string; children: TextRun[] } | null = null
    const push = (r: TextRun) => (link ? link.children.push(r) : out.push(r))
    const text = (s: string, extra: Marks = {}) => {
      const m = { ...marks, ...extra }
      return new TextRun({
        text: s,
        bold: m.bold,
        italics: m.italics,
        underline: m.underline ? {} : undefined,
        strike: m.strike,
        highlight: m.highlight ? 'yellow' : undefined,
        font: m.code ? MONO : undefined,
        style: link ? 'Hyperlink' : undefined,
      })
    }
    for (const c of t?.children ?? []) {
      switch (c.type) {
        case 'text':
        case 'raw_inline':
          push(text(c.content))
          break
        case 'code_inline':
          push(text(c.content, { code: true }))
          break
        case 'softbreak':
        case 'hardbreak':
          push(new TextRun({ break: 1 }))
          break
        case 'strong_open':
        case 'strong_close':
          marks.bold = c.nesting > 0
          break
        case 'em_open':
        case 'em_close':
          marks.italics = c.nesting > 0
          break
        case 's_open':
        case 's_close':
          marks.strike = c.nesting > 0
          break
        case 'mark_open':
        case 'mark_close':
          marks.highlight = c.nesting > 0
          break
        case 'u_open':
        case 'u_close':
          marks.underline = c.nesting > 0
          break
        case 'link_open': {
          const href = c.attrGet('href') ?? ''
          // Only links that lead somewhere outside the vault stay links.
          if (/^(https?:|mailto:)/i.test(href)) link = { href, children: [] }
          break
        }
        case 'link_close':
          if (link) out.push(new ExternalHyperlink({ link: link.href, children: link.children }))
          link = null
          break
        case 'image': {
          const src = c.attrGet('src') ?? ''
          const data = images.get(src)
          const size = data ? imageSize(data) : null
          if (!data || !size) {
            const name = decoded(src).split(/[\\/]/).pop()
            warnings.add(data ? `Image not in a format Word takes (PNG, JPEG, GIF): ${name}` : /^https?:/i.test(src) ? `Image on the web not embedded: ${src}` : `Image missing: ${name}`)
            const alt = c.children?.map((x) => x.content).join('') ?? ''
            if (alt) push(text(`[${alt}]`))
            break
          }
          const scale = Math.min(1, MAX_WIDTH / size.width)
          out.push(new ImageRun({ type: size.type, data, transformation: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) } }))
          break
        }
      }
    }
    return out
  }

  /**
   * Blocks from tokens[from, to), `depth` lists deep. `para` adds indents and borders to each paragraph.
   * `lead` is a list item's bullet, number or box: it goes on the item's first block, whatever that is
   * (a paragraph, a heading, a code block), and on an empty line of its own if the item starts with a
   * list or a table, or has nothing in it.
   */
  const blocks = (from: number, to: number, para: Partial<IParagraphOptions> = {}, depth = 0, lead?: Partial<IParagraphOptions>): Block[] => {
    const out: Block[] = []
    let pending = lead
    /** This block's paragraph options: the first one takes the item's mark, and the list's own indent. */
    const first = (): Partial<IParagraphOptions> => {
      if (!pending) return para
      const o = { ...para, indent: undefined, ...pending }
      pending = undefined
      return o
    }
    const markAlone = () => pending && out.push(new Paragraph({ ...first(), children: [] }))
    for (let i = from; i < to; i++) {
      const t = tokens[i]
      switch (t.type) {
        case 'heading_open':
          out.push(new Paragraph({ ...first(), heading: HEADINGS[Number(t.tag.slice(1)) - 1], children: runs(tokens[i + 1]) }))
          i += 2
          break
        case 'paragraph_open':
          out.push(new Paragraph({ ...first(), children: runs(tokens[i + 1]) }))
          i += 2
          break
        case 'bullet_list_open':
        case 'ordered_list_open':
        case 'task_list_open': {
          markAlone()
          const close = matching(tokens, i)
          const level = Math.min(8, depth)
          const instance = ++lists
          for (let j = i + 1; j < close; j++) {
            const it = tokens[j]
            if (it.type !== 'list_item_open' && it.type !== 'task_item_open') continue
            const end = matching(tokens, j)
            const mark: Partial<IParagraphOptions> =
              t.type === 'ordered_list_open'
                ? { numbering: { reference: 'ordered', level, instance } }
                : t.type === 'task_list_open'
                  ? { numbering: { reference: it.meta?.checked ? 'done' : 'todo', level } }
                  : { bullet: { level } }
            out.push(...blocks(j + 1, end, { ...para, indent: { left: 720 * (level + 1) } }, depth + 1, mark))
            j = end
          }
          i = close
          break
        }
        case 'blockquote_open': {
          const close = matching(tokens, i)
          const left = (para.indent && 'left' in para.indent ? Number(para.indent.left) : 0) + 720
          // An item that starts with a quote: its mark goes on the quote's first line.
          out.push(...blocks(i + 1, close, { ...para, indent: { left }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 12 } } }, depth, pending))
          pending = undefined
          i = close
          break
        }
        case 'fence':
        case 'code_block':
          out.push(
            new Paragraph({
              ...first(),
              shading: { type: ShadingType.CLEAR, fill: 'F1EFEB', color: 'auto' },
              children: t.content
                .replace(/\n$/, '')
                .split('\n')
                .map((line, k) => new TextRun({ text: line, font: MONO, size: 19, break: k ? 1 : undefined })),
            }),
          )
          break
        case 'hr':
          out.push(new Paragraph({ ...first(), border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } } }))
          break
        case 'table_open': {
          markAlone()
          const close = matching(tokens, i)
          const rows: TableRow[] = []
          let cells: TableCell[] = []
          let header = false
          for (let j = i + 1; j < close; j++) {
            const c = tokens[j]
            if (c.type === 'thead_open') header = true
            else if (c.type === 'thead_close') header = false
            else if (c.type === 'tr_open') cells = []
            else if (c.type === 'tr_close') rows.push(new TableRow({ children: cells, tableHeader: header }))
            else if (c.type === 'th_open' || c.type === 'td_open') {
              const end = matching(tokens, j)
              const align = /text-align:\s*(left|center|right)/.exec(c.attrGet('style') ?? '')?.[1]
              const children = runs(tokens.slice(j, end).find((x) => x.type === 'inline'))
              cells.push(
                new TableCell({
                  children: [
                    new Paragraph({
                      children,
                      alignment: align === 'center' ? AlignmentType.CENTER : align === 'right' ? AlignmentType.RIGHT : undefined,
                      style: c.type === 'th_open' ? 'TableHeading' : undefined,
                    }),
                  ],
                }),
              )
              j = end
            }
          }
          if (rows.length) out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }))
          i = close
          break
        }
        case 'html_block':
          // prepare() has already made raw HTML into text; anything left is shown as written.
          out.push(new Paragraph({ ...first(), children: [new TextRun({ text: t.content.replace(/\n$/, '') })] }))
          break
      }
    }
    markAlone() // an empty item still shows its bullet or number
    return out
  }

  const body = blocks(0, tokens.length)
  const head: Paragraph[] = []
  if (p.title) head.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(p.title)] }))
  for (const line of [p.author, p.date].filter(Boolean)) head.push(new Paragraph({ alignment: AlignmentType.LEFT, style: 'Subtitle', children: [new TextRun(line)] }))

  const level = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (l: number) => string) =>
    Array.from({ length: 9 }, (_, l) => ({ level: l, format, text: text(l), alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } } }))
  const doc = new Document({
    title: p.title || undefined,
    creator: p.author || undefined,
    // Word's own date fields want a full timestamp; a written date is kept as the subject line.
    subject: p.date || undefined,
    styles: {
      paragraphStyles: [
        { id: 'TableHeading', name: 'Table Heading', basedOn: 'Normal', run: { bold: true } },
        { id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal', run: { color: '666666' } },
      ],
    },
    numbering: {
      config: [
        { reference: 'ordered', levels: level(LevelFormat.DECIMAL, (l) => `%${l + 1}.`) },
        { reference: 'todo', levels: level(LevelFormat.BULLET, () => '☐') },
        { reference: 'done', levels: level(LevelFormat.BULLET, () => '☑') },
      ],
    },
    sections: [{ children: [...head, ...(body.length ? body : [new Paragraph('')])] }],
  })
  return { data: await Packer.toBuffer(doc), warnings: [...warnings] }
}

function decoded(src: string) {
  try {
    return decodeURI(src)
  } catch {
    return src
  }
}

function matching(tokens: Token[], i: number) {
  const open = tokens[i]
  const closeType = open.type.replace(/_open$/, '_close')
  for (let j = i + 1; j < tokens.length; j++) if (tokens[j].type === closeType && tokens[j].level === open.level) return j
  return tokens.length
}
