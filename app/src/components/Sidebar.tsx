import { useEffect, useRef, useState } from 'react'
import { findKind, kindDisplayName, kindId, kindName, kindOfFolder, kinds, notesMove, pieceName, plural, UNFILED_NAME } from '../lib/kinds.ts'
import './sidebar-kinds.css'
import type { FileEntry, Trashed, VoiceSummary } from '../lib/api.ts'
import { cleanTag, countsTags, hasTag, type TagCount } from '../lib/tags.ts'
import { Chips } from './Properties.tsx'
import { Icon } from './Icon.tsx'
import { briefLabel } from '../lib/brief.ts'
import { helpMod } from '../editor/help.ts'
import { SearchPane, type SearchProps } from './SearchPane.tsx'
import { titled } from '../lib/keys.ts'
import { IDEAS_FILE, isSpecialFile } from '../lib/special.ts'
import { isBrainPath } from '../lib/brain.ts'

/** 'search' has no rail button: it shows while it's in use (⌘⇧F), and its × goes back to the Vault. */
export type SidebarMode = 'vault' | 'exemplars' | 'voice' | 'search'

interface Props {
  mode: SidebarMode
  files: FileEntry[]
  current: string | null
  onOpen: (path: string) => void
  onCreate: (folder: string) => void
  onStar: (path: string) => void
  /** Whether a page may be starred (notes in the Brain may not). */
  canStar?: (path: string) => boolean
  /** The Brain's folder: its groups are labelled as the Brain's, and hold sources rather than drafts. */
  brainFolder?: string
  voices: VoiceSummary[]
  voiceView: string | null
  onVoice: (platform: string) => void
  actions: FileActions
  trash: Trashed[]
  onRestore: (id: string) => void
  search: SearchProps
  /** The vault's tags, with how many documents carry each. */
  tags: TagCount[]
  /** Bring files in: the file chooser, or files dropped on the sidebar. */
  onImport: (files?: File[]) => void
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
  /** Move a page to a folder, which makes it that folder's kind ('' is the top of the vault: Unfiled). */
  move: (path: string, folder: string) => void
  /** Rename a folder; a kind's folder takes its kind along, settings and all. */
  renameFolder: (folder: string, name: string) => void
  duplicate: (path: string) => void
  remove: (path: string) => void
  /** Open the page's Document layout: page view, style, header, target. */
  layout: (path: string) => void
  export: (path: string) => void
  /** Open the page with its brief's paste box (or its pinned brief, to edit). */
  pinBrief: (path: string) => void
  /** Whether the page has a brief pinned, as far as the app knows. */
  hasBrief: (path: string) => boolean
  /** Add and take away the page's front-matter tags, without opening it. */
  tag: (path: string, add: string[], remove: string[]) => void
}

/** Fewer than this and a voice profile has too little to go on. */
const ENOUGH = 3

export function Sidebar(p: Props) {
  const [dropping, setDropping] = useState(false)
  return (
    <aside
      className={`sidebar${dropping ? ' is-dropping' : ''}`}
      aria-label={p.mode === 'vault' ? 'Vault' : p.mode === 'exemplars' ? 'Exemplars' : p.mode === 'search' ? 'Search' : 'Voice'}
      // Files dropped here are imported (after review).
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        p.onImport([...e.dataTransfer.files])
      }}
    >
      {p.mode === 'vault' ? <Vault {...p} /> : p.mode === 'exemplars' ? <Exemplars {...p} /> : p.mode === 'search' ? <SearchPane {...p.search} /> : <Voices {...p} />}
    </aside>
  )
}

function Vault({ files: all, current, onOpen, onCreate, onStar, canStar, brainFolder, actions, trash, onRestore, tags, onImport, ideasOpen, ideaCount, onIdeas, onCaptureIdea }: Props) {
  // ideas.md has its own row at the top, so it isn't listed again among the pages.
  const files = all.filter((f) => !isSpecialFile(f.path))
  // Every kind's folder shows, even an empty one (an empty folder is still a kind), and the notes at
  // the top of the vault show as Unfiled, first.
  const allFolders = [...new Set([...files.map((f) => f.folder), ...kinds().map((k) => k.folder)])].sort((a, b) => (a ? (b ? a.localeCompare(b) : 1) : -1))
  const [showTrash, setShowTrash] = useState(false)
  const [showTags, setShowTags] = useState(() => readPref('tagsOpen'))
  const [picked, setPicked] = useState<string | null>(null)
  // A tag that's gone from the vault no longer filters anything.
  const filter = picked && tags.find((t) => t.tag.toLowerCase() === picked.toLowerCase())?.tag
  const shown = filter ? files.filter((f) => countsTags(f.path) && hasTag(f.tags, filter)) : files
  const folders = filter ? allFolders.filter((folder) => shown.some((f) => f.folder === folder)) : allFolders
  const toggleTags = () => {
    setShowTags(!showTags)
    writePref('tagsOpen', !showTags)
  }
  const ideasCurrent = ideasOpen || current?.toLowerCase() === IDEAS_FILE
  return (
    <>
      <div className="section-label section-head">
        <span>Vault</span>
        <VaultMenu onImport={onImport} />
      </div>
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
      {filter && (
        <div className="tag-filter" role="status">
          <span>
            Filtered by <b>#{filter}</b>
          </span>
          <button className="icon-btn small" title="Show every document" aria-label="Clear the tag filter" onClick={() => setPicked(null)}>
            ×
          </button>
        </div>
      )}
      {folders.map((folder) => (
        <div key={folder} className="folder">
          <FolderHead folder={folder} brainFolder={brainFolder} onCreate={onCreate} actions={actions} count={countIn(all, folder)} />
          {shown
            .filter((f) => f.folder === folder)
            .map((f) => (
              <FileRow
                key={f.path}
                f={f}
                current={current}
                onOpen={onOpen}
                onStar={f.exemplar || !canStar || canStar(f.path) ? onStar : undefined}
                actions={actions}
                folders={allFolders}
                brainFolder={brainFolder}
                vaultTags={tags}
              />
            ))}
        </div>
      ))}
      {tags.length > 0 && (
        <div className="folder tags">
          <button className="folder-name tags-head" onClick={toggleTags} aria-expanded={showTags}>
            <span>Tags</span>
            <span className="count">{tags.length}</span>
          </button>
          {showTags &&
            tags.map((t) => {
              const depth = t.tag.split('/').length - 1
              const on = t.tag === filter
              return (
                <button
                  key={t.tag}
                  className={`tag-row${on ? ' is-current' : ''}`}
                  style={{ paddingLeft: 14 + depth * 12 }}
                  title={`#${t.tag}`}
                  aria-pressed={on}
                  onClick={() => setPicked(on ? null : t.tag)}
                >
                  {/* A nested tag shows its own part after a slash, so #craft and #writing/craft read apart. */}
                  <span className="tag-name">{depth ? `/${t.tag.split('/').pop()}` : `#${t.tag}`}</span>
                  <span className="count">{t.count}</span>
                </button>
              )
            })}
        </div>
      )}
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

/** The Vault header's ⋯ menu. */
function VaultMenu({ onImport }: { onImport: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div ref={box} className="section-menu">
      <button className="more" title="More" aria-label="Vault menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button
            role="menuitem"
            title={titled('Import files', 'import')}
            onClick={() => {
              setOpen(false)
              onImport()
            }}
          >
            Import…
          </button>
        </div>
      )}
    </div>
  )
}

function Exemplars({ files, current, onOpen, onStar, canStar, actions, tags }: Props) {
  const folders = [...new Set(files.map((f) => f.folder))].sort()
  // A note's kind is its folder's ('' is Unfiled), as listed by the server.
  const platformOf = (f: FileEntry) => (f.platform ?? '').toLowerCase()
  // The writer's kinds first, then anything else the vault uses (Unfiled, say).
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
              <FileRow
                key={f.path}
                f={f}
                current={current}
                onOpen={onOpen}
                onStar={f.exemplar || !canStar || canStar(f.path) ? onStar : undefined}
                actions={actions}
                folders={folders}
                vaultTags={tags}
              />
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
  brainFolder,
  vaultTags,
}: {
  f: FileEntry
  current: string | null
  onOpen: (p: string) => void
  onStar?: (p: string) => void
  actions: FileActions
  folders: string[]
  brainFolder?: string
  vaultTags: TagCount[]
}) {
  const [menu, setMenu] = useState<null | 'main' | 'move' | 'new-folder' | 'tags'>(null)
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
    <div
      ref={box}
      className={`file-row${f.path === current ? ' is-current' : ''}${menu ? ' has-menu' : ''}`}
      // Dragged onto a folder's name, it moves there (and becomes that folder's kind).
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, f.path)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
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
      {onStar && (
        <button
          className={`star${f.exemplar ? ' is-on' : ''}`}
          aria-pressed={f.exemplar}
          title={f.exemplar ? 'Exemplar. Click to un-star' : 'Star as an exemplar: sounds like you'}
          onClick={() => onStar(f.path)}
        >
          <Icon name="star" />
        </button>
      )}
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
          <button role="menuitem" onClick={() => setMenu('tags')}>
            Tags… <span className="muted">{f.fmTags?.length ? f.fmTags.length : '›'}</span>
          </button>
          <button role="menuitem" onClick={act(() => actions.duplicate(f.path))}>
            Duplicate
          </button>
          <button role="menuitem" onClick={act(() => actions.layout(f.path))}>
            Document layout…
          </button>
          {onStar && (
            <button role="menuitem" onClick={act(() => onStar(f.path))}>
              {f.exemplar ? 'Un-star' : 'Star as exemplar'}
            </button>
          )}
          <button role="menuitem" onClick={act(() => actions.pinBrief(f.path))}>
            {briefLabel(f.platform, actions.hasBrief(f.path))}
          </button>
          <button role="menuitem" onClick={act(() => actions.export(f.path))}>
            Export…
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
          {[...new Set(['', ...folders])].map((folder) => (
            <button key={folder} role="menuitem" disabled={folder === f.folder} onClick={act(() => actions.move(f.path, folder))}>
              {folderLabel(folder, brainFolder)}
              {folder === f.folder && <span className="muted">here</span>}
            </button>
          ))}
          <hr />
          <button role="menuitem" title="A new folder at the top of the vault is a new kind" onClick={() => setMenu('new-folder')}>
            New folder (a new kind)…
          </button>
        </div>
      )}
      {menu === 'tags' && <TagsMenu f={f} vaultTags={vaultTags} onBack={() => setMenu('main')} onChange={(add, remove) => actions.tag(f.path, add, remove)} />}
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

/**
 * A page's tags from its ⋯ menu, without opening it: the same chips and suggestions as Properties.
 * Only front-matter tags can be taken away here; #tags in the text are listed, to be edited there.
 */
function TagsMenu({ f, vaultTags, onBack, onChange }: { f: FileEntry; vaultTags: TagCount[]; onBack: () => void; onChange: (add: string[], remove: string[]) => void }) {
  const own = f.fmTags ?? []
  const lower = new Set(own.map((t) => t.toLowerCase()))
  const inText = f.tags.filter((t) => !lower.has(t.toLowerCase()))
  return (
    <div className="menu file-tags" role="dialog" aria-label={`Tags for ${f.title}`}>
      <button className="menu-back" onClick={onBack}>
        ‹ Tags
      </button>
      <Chips
        label={`tags for ${f.title}`}
        values={own}
        clean={cleanTag}
        suggestions={vaultTags}
        prefix="#"
        autoFocus
        onChange={(next) => {
          const had = (list: string[], t: string) => list.some((x) => x.toLowerCase() === t.toLowerCase())
          onChange(
            next.filter((t) => !had(own, t)),
            own.filter((t) => !had(next, t)),
          )
        }}
      />
      {inText.length > 0 && <p className="file-tags-note">In the text: {inText.map((t) => `#${t}`).join(' ')}</p>}
    </div>
  )
}

// Grouped by kind, pieces read as a plural: "LinkedIn posts", "YT scripts".
const platformLabel = (p: string) => (findKind(kinds(), p) ? plural(kindDisplayName(kindName(kinds(), p))) : kindName(kinds(), p))

/** What a dragged page carries: its path. */
const DRAG_TYPE = 'application/x-ekdanta-path'

const inBrain = (folder: string, brain?: string) => !!brain && isBrainPath(folder + '/x', brain)
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * A folder's name in the sidebar. The top of the vault is Unfiled. A kind's folder takes the kind's
 * name ("LinkedIn posts"), and a folder inside it says so: essays/2024 reads "Essays · 2024", since it's
 * still Essays. The Brain's shelves read "Brain · Books"; any other folder keeps its own name.
 */
export function folderLabel(folder: string, brain?: string) {
  if (!folder) return UNFILED_NAME
  const parts = folder.split('/')
  const last = parts[parts.length - 1]
  // brain/books reads "Brain · Books", so the Brain's shelves aren't mistaken for the writer's own groups.
  if (inBrain(folder, brain)) return folder.toLowerCase() === brain!.toLowerCase() ? 'Brain' : `Brain · ${capital(last)}`
  // A folder named like an id (linkedin, yt-scripts) reads as its kind ("LinkedIn posts"); one the
  // writer named in words ("Book chapters", "Correspondence") reads as they wrote it.
  const kind = kindOfFolder(kinds(), folder)
  const head = kind && parts[0] === kindId(parts[0]) ? plural(kindDisplayName(kind.name)) : capital(parts[0])
  return [head, ...parts.slice(1).map(capital)].join(' · ')
}

/**
 * A folder's name in the Vault list, with its + (a new draft there, which is its kind) and a way to
 * rename it (double-click). Pages dropped on it move into it. The top of the vault (Unfiled) and the
 * Brain can't be renamed here.
 */
function FolderHead({ folder, brainFolder, onCreate, actions, count }: { folder: string; brainFolder?: string; onCreate: (folder: string) => void; actions: FileActions; count: number }) {
  const [over, setOver] = useState(false)
  const [renaming, setRenaming] = useState(false)
  // A rename waiting for the writer's yes: every note in the folder moves with it.
  const [asking, setAsking] = useState<string | null>(null)
  const label = folderLabel(folder, brainFolder)
  const name = folder.split('/').pop() ?? ''
  const canRename = !!folder && !inBrain(folder, brainFolder)
  return (
    <>
      <div
        className={`folder-name${over ? ' is-drop' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          setOver(true)
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
        onDrop={(e) => {
          setOver(false)
          const rel = e.dataTransfer.getData(DRAG_TYPE)
          if (!rel) return
          e.preventDefault()
          e.stopPropagation()
          const from = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
          if (from !== folder) actions.move(rel, folder)
        }}
      >
        {renaming ? (
          <input
            className="folder-rename"
            defaultValue={name}
            aria-label={`New name for ${folder}/`}
            autoFocus
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') {
                e.currentTarget.value = name
                setRenaming(false)
              }
            }}
            onBlur={(e) => {
              setRenaming(false)
              const next = e.target.value.trim()
              if (next && next !== name) setAsking(next)
            }}
          />
        ) : (
          <span
            title={folder ? `${folder}/${canRename ? ' · double-click to rename' : ''}` : 'Notes at the top of the vault: pick a kind to file one'}
            onDoubleClick={() => canRename && setRenaming(true)}
          >
            {label}
          </span>
        )}
        {/* Sources are added on the Brain page, with their details; a blank draft there would be neither. */}
        {!inBrain(folder, brainFolder) && (
          <button className="icon-btn small" title={`New draft in ${label}`} onClick={() => onCreate(folder)}>
            <Icon name="plus" />
          </button>
        )}
      </div>
      {asking && (
        <p className="sidebar-hint folder-rename-ask" role="alertdialog" aria-label={`Rename ${folder}/`}>
          Rename the {label} folder to {asking}? {notesMove(count)}{' '}
          <button
            className="link-btn"
            onClick={() => {
              setAsking(null)
              actions.renameFolder(folder, asking)
            }}
          >
            Rename
          </button>{' '}
          ·{' '}
          <button className="link-btn" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </p>
      )}
    </>
  )
}

/** How many notes are in a folder, at any depth. */
const countIn = (files: FileEntry[], folder: string) => {
  const f = folder.normalize('NFC').toLowerCase() + '/'
  return files.filter((x) => x.path.normalize('NFC').toLowerCase().startsWith(f)).length
}

function readPref(key: string) {
  try {
    return localStorage.getItem('ekdanta.' + key) === 'true'
  } catch {
    return false
  }
}

function writePref(key: string, value: boolean) {
  try {
    localStorage.setItem('ekdanta.' + key, String(value))
  } catch {
    /* preferences are a convenience */
  }
}
