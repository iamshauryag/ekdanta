import type { FileEntry } from '../lib/api.ts'
import { Icon } from './Icon.tsx'

interface Props {
  files: FileEntry[]
  current: string | null
  onOpen: (path: string) => void
  onCreate: (folder: string) => void
}

export function Sidebar({ files, current, onOpen, onCreate }: Props) {
  const folders = [...new Set(files.map((f) => f.folder))].sort()
  return (
    <aside className="sidebar" aria-label="Vault">
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
              <button key={f.path} className={`file${f.path === current ? ' is-current' : ''}${f.title === 'Untitled' ? ' is-untitled' : ''}`} onClick={() => onOpen(f.path)}>
                {f.title}
              </button>
            ))}
        </div>
      ))}
    </aside>
  )
}

const LABELS: Record<string, string> = { linkedin: 'LinkedIn' }
function folderLabel(folder: string) {
  if (!folder) return 'Vault'
  const last = folder.split('/').pop()!
  return LABELS[last.toLowerCase()] ?? last[0].toUpperCase() + last.slice(1)
}
