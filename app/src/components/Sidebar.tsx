import type { FileEntry, VoiceSummary } from '../lib/api.ts'
import { Icon } from './Icon.tsx'
import { helpMod } from '../editor/help.ts'

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
}

const PLATFORMS = ['essay', 'linkedin', 'email', 'text', 'blog']
/** Fewer than this and a voice profile has too little to go on. */
const ENOUGH = 3

export function Sidebar(p: Props) {
  return (
    <aside className="sidebar" aria-label={p.mode === 'vault' ? 'Vault' : p.mode === 'exemplars' ? 'Exemplars' : 'Voice'}>
      {p.mode === 'vault' ? <Vault {...p} /> : p.mode === 'exemplars' ? <Exemplars {...p} /> : <Voices {...p} />}
    </aside>
  )
}

function Vault({ files, current, onOpen, onCreate, onStar }: Props) {
  const folders = [...new Set(files.map((f) => f.folder))].sort()
  return (
    <>
      <div className="section-label">Vault</div>
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
              <FileRow key={f.path} f={f} current={current} onOpen={onOpen} onStar={onStar} />
            ))}
        </div>
      ))}
    </>
  )
}

function Exemplars({ files, current, onOpen, onStar }: Props) {
  const platformOf = (f: FileEntry) => (f.platform ?? 'essay').toLowerCase()
  // The usual platforms first, then anything else the vault uses (notes, say).
  const used = [...new Set([...PLATFORMS, ...files.map(platformOf)])].filter((pl) => files.some((f) => platformOf(f) === pl))
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
              <FileRow key={f.path} f={f} current={current} onOpen={onOpen} onStar={onStar} />
            ))}
            {PLATFORMS.includes(pl) && starred.length < ENOUGH && (
              <p className="sidebar-hint">
                {starred.length === 0 ? 'None yet. ' : ''}Star {ENOUGH - starred.length} more {pieceName(pl, ENOUGH - starred.length)} for a reliable profile.
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
      <p className="sidebar-note">How you write on each platform, learned from your exemplars. <span className="nowrap">{helpMod}3–{helpMod}5</span> follow it.</p>
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

function FileRow({ f, current, onOpen, onStar }: { f: FileEntry; current: string | null; onOpen: (p: string) => void; onStar: (p: string) => void }) {
  return (
    <div className={`file-row${f.path === current ? ' is-current' : ''}`}>
      <button className={`file${f.path === current ? ' is-current' : ''}${f.title === 'Untitled' ? ' is-untitled' : ''}`} onClick={() => onOpen(f.path)}>
        {f.title}
      </button>
      <button
        className={`star${f.exemplar ? ' is-on' : ''}`}
        aria-pressed={f.exemplar}
        title={f.exemplar ? 'Exemplar. Click to un-star' : 'Star as an exemplar: sounds like you'}
        onClick={() => onStar(f.path)}
      >
        <Icon name="star" />
      </button>
    </div>
  )
}

const platformLabel = (p: string) => (p === 'linkedin' ? 'LinkedIn' : p === 'note' ? 'Notes' : p[0].toUpperCase() + p.slice(1))
function pieceName(platform: string, n: number) {
  const one = { essay: 'essay', linkedin: 'LinkedIn post', email: 'email', text: 'message', blog: 'blog post' }[platform] ?? 'piece'
  return n === 1 ? one : one + 's'
}

const LABELS: Record<string, string> = { linkedin: 'LinkedIn' }
function folderLabel(folder: string) {
  if (!folder) return 'Vault'
  const last = folder.split('/').pop()!
  return LABELS[last.toLowerCase()] ?? last[0].toUpperCase() + last.slice(1)
}
