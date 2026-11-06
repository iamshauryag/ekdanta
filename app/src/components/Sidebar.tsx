import { useState } from 'react'
import type { FileEntry } from '../lib/api.ts'
import { Icon } from './Icon.tsx'

interface Props {
  files: FileEntry[]
  current: string | null
  onOpen: (path: string) => void
  onCreate: (folder: string, name: string) => void
}

export function Sidebar({ files, current, onOpen, onCreate }: Props) {
  const [creating, setCreating] = useState<string | null>(null)
  const [name, setName] = useState('')
  const folders = [...new Set(files.map((f) => f.folder))].sort()

  const submit = () => {
    if (creating !== null && name.trim()) onCreate(creating, name)
    setCreating(null)
    setName('')
  }

  return (
    <aside className="sidebar" aria-label="Vault">
      <div className="section-label">Vault</div>
      {folders.map((folder) => (
        <div key={folder} className="folder">
          <div className="folder-name">
            <span>{folderLabel(folder)}</span>
            <button className="icon-btn small" title={`New document in ${folder || 'vault'}`} onClick={() => setCreating(folder)}>
              <Icon name="plus" />
            </button>
          </div>
          {creating === folder && (
            <input
              className="new-doc"
              autoFocus
              placeholder="Title, then Return"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') setCreating(null)
              }}
              onBlur={submit}
            />
          )}
          {files
            .filter((f) => f.folder === folder)
            .map((f) => (
              <button key={f.path} className={`file${f.path === current ? ' is-current' : ''}`} onClick={() => onOpen(f.path)}>
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
