// Front-matter stays as the writer wrote it; only keys Ekdanta changes are rewritten.
export type Meta = Record<string, string>

export function splitFrontMatter(content: string): { meta: Meta; body: string; raw: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: content, raw: '' }
  const meta: Meta = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  // Drop the blank line that conventionally follows the closing fence; joinFrontMatter restores it.
  return { meta, body: content.slice(m[0].length).replace(/^\n/, ''), raw: m[1] }
}

export function joinFrontMatter(raw: string, meta: Meta, body: string) {
  const lines = raw ? raw.split('\n') : []
  for (const [key, value] of Object.entries(meta)) {
    const i = lines.findIndex((l) => l.startsWith(key + ':'))
    const line = `${key}: ${value}`
    if (i >= 0) {
      if (lines[i].replace(/["']/g, '') !== line) lines[i] = line
    } else lines.push(line)
  }
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n${body}` : body
}
