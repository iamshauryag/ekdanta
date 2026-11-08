// The Piece panel's part of Break it down: the posts drawn from this piece (notes whose `from:` links
// to it), where this post came from when it's one of them, and the way in to break the piece down.
import { useMemo } from 'react'
import type { FileEntry } from '../lib/api.ts'
import { derivedFrom, resolveWikiLink } from '../lib/breakdown.ts'
import { kindName, kinds } from '../lib/kinds.ts'
import './breakdown.css'

interface Props {
  path: string
  files: FileEntry[]
  /** Help ceiling 0 turns Break it down off. */
  ceiling: number
  onOpenDoc: (path: string) => void
  onBreakDown: () => void
}

export function DerivedPosts({ path, files, ceiling, onOpenDoc, onBreakDown }: Props) {
  const posts = useMemo(() => derivedFrom(files, path), [files, path])
  const source = useMemo(() => {
    const me = files.find((f) => f.path === path)
    const rel = resolveWikiLink(
      files.map((f) => f.path),
      me?.from,
    )
    return rel ? files.find((f) => f.path === rel) : undefined
  }, [files, path])
  // A post drawn from a piece is short already: it shows where it came from, not a way to break it down again.
  const canBreak = ceiling >= 1 && !source
  if (!posts.length && !source && !canBreak) return null
  return (
    <div className="bd-derived">
      {source && (
        <>
          <div className="panel-head">Drawn from</div>
          <ul>
            <li>
              <button className="link" onClick={() => onOpenDoc(source.path)} title={source.path}>
                {source.title}
              </button>
            </li>
          </ul>
        </>
      )}
      {(posts.length > 0 || canBreak) && <div className="panel-head">Posts from this piece {posts.length > 0 && <em>· {posts.length}</em>}</div>}
      {posts.length > 0 && (
        <ul>
          {posts.map((f) => (
            <li key={f.path}>
              <button className="link" onClick={() => onOpenDoc(f.path)} title={f.path}>
                {f.title}
              </button>
              <span className="muted">{kindName(kinds(), f.platform ?? '')}</span>
            </li>
          ))}
        </ul>
      )}
      {canBreak && (
        <button className="btn" onClick={onBreakDown}>
          Break it down into posts…
        </button>
      )}
    </div>
  )
}
