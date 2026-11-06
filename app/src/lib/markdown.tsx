// A small Markdown renderer for Ekdanta's own notes (voice profiles): headings, lists,
// quotes, paragraphs, emphasis, code and [[wikilinks]]. Not a general-purpose parser.
import { Fragment, type ReactNode } from 'react'

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; items: Block[][] }

/** What a [[wikilink]] opens, if it leads anywhere. */
type Link = (target: string) => (() => void) | undefined

const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

function parse(lines: string[]): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
    } else if (line.trim().startsWith('<!--')) {
      // Comments are notes to whoever edits the file, not part of the page.
      while (i < lines.length && !lines[i].includes('-->')) i++
      i++
    } else if (/^#{1,6}\s/.test(line)) {
      const m = line.match(/^(#{1,6})\s+(.*)$/)!
      out.push({ kind: 'heading', level: m[1].length, text: m[2].trim() })
      i++
    } else if (/^\s*>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push({ kind: 'quote', blocks: parse(quoted) })
    } else if (ITEM.test(line)) {
      const ordered = /\d/.test(line.match(ITEM)![2])
      const items: Block[][] = []
      while (i < lines.length) {
        const m = lines[i].match(ITEM)
        if (!m || m[1].length > 0) break
        // An item runs on through the indented lines beneath it.
        const body = [m[3]]
        i++
        while (i < lines.length && (/^\s{2,}\S/.test(lines[i]) || (!lines[i].trim() && /^\s{2,}\S/.test(lines[i + 1] ?? '')))) body.push(lines[i++].replace(/^\s{2,4}/, ''))
        items.push(parse(body))
      }
      out.push({ kind: 'list', ordered, items })
    } else {
      const para: string[] = []
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|<!--)/.test(lines[i]) && !ITEM.test(lines[i])) para.push(lines[i++].trim())
      out.push({ kind: 'para', text: para.join(' ') })
    }
  }
  return out
}

function inline(text: string, onLink?: Link): ReactNode[] {
  const parts = text.split(/(\[\[[^\]]+\]\]|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g)
  return parts.map((p, i) => {
    if (p.startsWith('[[')) {
      const [target, alias] = p.slice(2, -2).split('|')
      const open = onLink?.(target.trim())
      return open ? (
        <button key={i} className="link wikilink" onClick={open}>
          {(alias ?? target).trim()}
        </button>
      ) : (
        <span key={i} className="wikilink">
          {(alias ?? target).trim()}
        </span>
      )
    }
    if (p.startsWith('`') && p.length > 1) return <code key={i}>{p.slice(1, -1)}</code>
    if (p.startsWith('**') && p.length > 3) return <strong key={i}>{p.slice(2, -2)}</strong>
    if (/^[*_].+[*_]$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>
    return <Fragment key={i}>{p}</Fragment>
  })
}

function render(blocks: Block[], onLink?: Link): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.kind) {
      case 'heading': {
        const H = `h${Math.min(6, b.level + 1)}` as 'h2'
        return <H key={i}>{inline(b.text, onLink)}</H>
      }
      case 'para':
        return <p key={i}>{inline(b.text, onLink)}</p>
      case 'quote':
        return <blockquote key={i}>{render(b.blocks, onLink)}</blockquote>
      case 'list': {
        const L = b.ordered ? 'ol' : 'ul'
        return (
          <L key={i}>
            {b.items.map((item, j) => (
              // A one-line item reads as text, not as a paragraph inside the bullet.
              <li key={j}>{item.length && item[0].kind === 'para' ? [inline(item[0].text, onLink), ...render(item.slice(1), onLink)] : render(item, onLink)}</li>
            ))}
          </L>
        )
      }
    }
  })
}

export function Markdown({ text, onLink, className }: { text: string; onLink?: Link; className?: string }) {
  return <div className={className ?? 'md'}>{render(parse(text.split('\n')), onLink)}</div>
}
