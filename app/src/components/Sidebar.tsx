import { useEffect, useRef, useState } from 'react'
import { findKind, kindName, kinds, pieceName, plural } from '../lib/kinds.ts'
import type { FileEntry, Trashed, VoiceSummary } from '../lib/api.ts'
import { Icon } from './Icon.tsx'
import { briefLabel } from '../lib/brief.ts'
import { helpMod } from '../editor/help.ts'
import { titled } from '../lib/keys.ts'
import { IDEAS_FILE, isSpecialFile } from '../lib/special.ts'

export type SidebarMode = 'vault' | 'exemplars' | 'voice'

interface Props {
  mode: SidebarMode
  files: FileEntry[]
  current: string | null
  onOpen: (path: string) => void
  onCreate: (folder: string) => void
  onStar: (path: string) => void
  voices: VoiceSummary[]
  voiceView: string | null
  onVoice: (platform: string) => void
  actions: FileActions
  trash: Trashed[]
  onRestore: (id: string) => void
  /** Whether the Ideas page fills the page. */
  ideasOpen: boolean
  /** How many ideas ideas.md holds; null until it's been read. */
  ideaCount: number | null
  onIdeas: () => void
  onCaptureIdea: () => void
}

/** What a page's ⋯ menu can do to it. */
export interface FileActions {
  rename: (path: string, title: string) => void
  move: (path: string, folder: string) => void
  duplicate: (path: string) => void
  remove: (path: string) => void
  /** Open the page with its brief's paste box (or its pinned brief, to edit). */
  pinBrief: (path: string) => void
  /** Whether the page has a brief pinned, as far as the app knows. */
  hasBrief: (path: string) => boolean
}

/** Fewer than this and a voice profile has too little to go on. */
const ENOUGH = 3

export function Sidebar(p: Props) {
  return (
    <aside className="sidebar" aria-label={p.mode === 'vault' ? 'Vault' : p.mode === 'exemplars' ? 'Exemplars' : 'Voice'}>
      {p.mode === 'vault' ? <Vault {...p} /> : p.mode === 'exemplars' ? <Exemplars {...p} /> : <Voices {...p} />}
    </aside>
  )
}

function Vault({ files: all, current, onOpen, onCreate, onStar, actions, trash, onRestore, ideasOpen, ideaCount, onIdeas, onCaptureIdea }: Props) {
  // ideas.md has its own row at the top, so it isn't listed again among the pages.
  const files = all.filter((f) => !isSpecialFile(f.path))
  const folders = [...new Set(files.map((f) => f.folder))].sort()
  const [showTrash, setShowTrash] = useState(false)
  const ideasCurrent = ideasOpen || current?.toLowerCase() === IDEAS_FILE
  return (
    <>
      <div className="section-label">Vault</div>
      <div className="folder ideas">
        <div className={`folder-name ideas-head${ideasCurrent ? ' is-current' : ''}`}>
          <button className="ideas-open" aria-current={ideasCurrent ? 'page' : undefined} aria-label={ideaCount !== null ? `Ideas, ${ideaCount}` : 'Ideas'} onClick={onIdeas}>
            Ideas
          </button>
          <button className="icon-btn small" title={titled('Capture idea', 'captureIdea')} onClick={onCaptureIdea}>
            <Icon name="plus" />
          </button>
          {/* The count sits at the far right, past the +; it opens the page too. */}
          {ideaCount !== null && (
            <span className="count" aria-hidden="true" onClick={onIdeas}>
              {ideaCount}
            </span>
          )}
        </div>
      </div>
      {folders.map((folder) => (
        <div key={folder} className="folder">
          <div className="folder-name">
            <span>{folderLabel(folder)}</span>
            <button className="icon-btn small" title={`New draft in ${folderLabel(folder)}`} onClick={() => onCreate(folder)}>
              <Icon name="plus" />
            </button>
          </div>
          {files
            .filter((f) => f.folder === folder)
            .map((f) => (
              <FileRow key={f.path} f={f} current={current} onOpen={onOpen} onStar={onStar} actions={actions} folders={folders} />
            ))}
        </div>
      ))}
      {trash.length > 0 && (
        <div className="folder trash">
          <button className="folder-name trash-head" onClick={() => setShowTrash((o) => !o)} aria-expanded={showTrash}>
            <span>Recently deleted</span>
            <span className="count">{trash.length}</span>
          </button>
          {showTrash &&
            trash.map((t) => (
              <div key={t.id} className="file-row trashed">
                <span className="file" title={`Was ${t.path}`}>
                  {t.title}
                </span>
                <button className="restore" onClick={() => onRestore(t.id)}>
                  Restore
                </button>
              </div>
            ))}
          {showTrash && <p className="sidebar-hint">Kept in .ekdanta/trash in the vault until you empty it.</p>}
        </div>
      )}
    </>
  )
}

function Exemplars({ files, current, onOpen, onStar, actions }: Props) {
  const folders = [...new Set(files.map((f) => f.folder))].sort()
  const platformOf = (f: FileEntry) => (f.platform ?? 'essay').toLowerCase()
  // The usual platforms first, then anything else the vault uses (notes, say).
  const ids = kinds().map((k) => k.id)
  const used = [...new Set([...ids, ...files.map(platformOf)])].filter((pl) => files.some((f) => platformOf(f) === pl))
  return (
    <>
      <div className="section-label">Exemplars</div>
      <p className="sidebar-note">The pieces that sound most like you. Voice profiles are built from them.</p>
      {used.map((pl) => {
        const starred = files.filter((f) => f.exemplar && platformOf(f) === pl)
        return (
          <div key={pl} className="folder">
            <div className="folder-name">
              <span>{platformLabel(pl)}</span>
              <span className="count">{starred.length}</span>
            </div>
            {starred.map((f) => (
              <FileRow key={f.path} f={f} current={current} onOpen={onOpen} onStar={onStar} actions={actions} folders={folders} />
            ))}
            {ids.includes(pl) && starred.length < ENOUGH && (
              <p className="sidebar-hint">
                {starred.length === 0 ? 'None yet. ' : ''}Star {ENOUGH - starred.length} more {pieceName(kinds(), pl, ENOUGH - starred.length)} for a reliable profile.
              </p>
            )}
          </div>
        )
      })}
    </>
  )
}

function Voices({ voices, voiceView, onVoice }: Props) {
  return (
    <>
      <div className="section-label">Voice</div>
      <p className="sidebar-note">
        How you write each kind of piece, learned from your exemplars.{' '}
        <span className="nowrap">
          {helpMod}3–{helpMod}5
        </span>{' '}
        follow it.
      </p>
      {voices.map((v) => (
        <button key={v.platform} className={`voice-row${voiceView === v.platform ? ' is-current' : ''}`} onClick={() => onVoice(v.platform)}>
          <span>{platformLabel(v.platform)}</span>
          <small className={!v.exists ? '' : v.upToDate ? 'is-ok' : 'is-stale'}>{!v.exists ? 'Not built' : v.upToDate ? 'Up to date' : 'Out of date'}</small>
        </button>
      ))}
      {!voices.length && <p className="sidebar-hint">Write a few pieces first.</p>}
    </>
  )
}

function FileRow({
  f,
  current,
  onOpen,
  onStar,
  actions,
  folders,
}: {
  f: FileEntry
  current: string | null
  onOpen: (p: string) => void
  onStar: (p: string) => void
  actions: FileActions
  folders: string[]
}) {
  const [menu, setMenu] = useState<null | 'main' | 'move' | 'new-folder'>(null)
  const [renaming, setRenaming] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setMenu(null)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [menu])
  const act = (fn: () => void) => () => {
    setMenu(null)
    fn()
  }

  return (
    <div ref={box} className={`file-row${f.path === current ? ' is-current' : ''}${menu ? ' has-menu' : ''}`}>
      {renaming ? (
        <input
          className="file rename"
          defaultValue={f.title === 'Untitled' ? '' : f.title}
          placeholder="Title"
          aria-label="New title"
          autoFocus
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') setRenaming(false)
          }}
          onBlur={(e) => {
            setRenaming(false)
            const title = e.target.value.trim()
            if (title && title !== f.title) actions.rename(f.path, title)
          }}
        />
      ) : (
        <button className={`file${f.path === current ? ' is-current' : ''}${f.title === 'Untitled' ? ' is-untitled' : ''}`} onClick={() => onOpen(f.path)} onDoubleClick={() => setRenaming(true)}>
          {f.title}
        </button>
      )}
      <button
        className={`star${f.exemplar ? ' is-on' : ''}`}
        aria-pressed={f.exemplar}
        title={f.exemplar ? 'Exemplar. Click to un-star' : 'Star as an exemplar: sounds like you'}
        onClick={() => onStar(f.path)}
      >
        <Icon name="star" />
      </button>
      <button className="more" title="More" aria-haspopup="menu" aria-expanded={!!menu} onClick={() => setMenu(menu ? null : 'main')}>
        <Icon name="more" />
      </button>
      {menu === 'main' && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={act(() => setRenaming(true))}>
            Rename
          </button>
          <button role="menuitem" onClick={() => setMenu('move')}>
            Move to… <span className="muted">›</span>
          </button>
          <button role="menuitem" onClick={act(() => actions.duplicate(f.path))}>
            Duplicate
          </button>
          <button role="menuitem" onClick={act(() => onStar(f.path))}>
            {f.exemplar ? 'Un-star' : 'Star as exemplar'}
          </button>
          <button role="menuitem" onClick={act(() => actions.pinBrief(f.path))}>
            {briefLabel(f.platform, actions.hasBrief(f.path))}
          </button>
          <hr />
          <button role="menuitem" className="danger" onClick={act(() => actions.remove(f.path))}>
            Delete
          </button>
        </div>
      )}
      {menu === 'move' && (
        <div className="menu" role="menu">
          <button className="menu-back" onClick={() => setMenu('main')}>
            ‹ Move to
          </button>
          {folders.map((folder) => (
            <button key={folder} role="menuitem" disabled={folder === f.folder} onClick={act(() => actions.move(f.path, folder))}>
              {folderLabel(folder)}
              {folder === f.folder && <span className="muted">here</span>}
            </button>
          ))}
          <hr />
          <button role="menuitem" onClick={() => setMenu('new-folder')}>
            New folder…
          </button>
        </div>
      )}
      {menu === 'new-folder' && (
        <form
          className="menu"
          onSubmit={(e) => {
            e.preventDefault()
            const name = new FormData(e.currentTarget).get('folder')?.toString().trim()
            if (name) act(() => actions.move(f.path, name))()
          }}
        >
          <input name="folder" placeholder="Folder name" aria-label="Folder name" autoFocus />
        </form>
      )}
    </div>
  )
}

// Grouped by kind, pieces read as a plural: "LinkedIn posts", "YT scripts".
const platformLabel = (p: string) => (findKind(kinds(), p) ? plural(kindName(kinds(), p)) : p === 'note' ? 'Notes' : kindName(kinds(), p))

/** A kind's own folder takes the kind's name; any other keeps its own. */
function folderLabel(folder: string) {
  if (!folder) return 'Vault'
  const last = folder.split('/').pop()!
  const kind = !folder.includes('/') && kinds().find((k) => k.folder === last.toLowerCase())
  return kind ? plural(kind.name) : last[0].toUpperCase() + last.slice(1)
}
