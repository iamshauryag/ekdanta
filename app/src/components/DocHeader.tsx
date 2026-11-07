import type { Header } from '../lib/docstyle.ts'

/**
 * What sits above the text on the page: MLA's four-line heading block, or an APA or Chicago title page.
 * It is drawn from the piece's front matter and never part of the text, so it can't be typed into,
 * isn't counted, and stays out of the Markdown. Change it from Document layout.
 */
export function DocHeader({ header, onEdit }: { header: Header; onEdit: () => void }) {
  if (!header) return null
  if (header.type === 'block')
    return (
      <div className="dm-heading" contentEditable={false} title="From Document layout. Click to change" onClick={onEdit}>
        {header.lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    )
  return (
    <div className="dm-titlepage-body" contentEditable={false} title="From Document layout. Click to change" onClick={onEdit}>
      <div className={`dm-tp-title${header.title ? '' : ' is-empty'}`}>{header.title || 'Untitled'}</div>
      <div className="dm-tp-lines">
        {header.lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  )
}
