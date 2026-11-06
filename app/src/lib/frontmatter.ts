// Front-matter stays as the writer wrote it; only keys Ekdanta changes are rewritten.
export type Meta = Record<string, string>

export function splitFrontMatter(content: string): { meta: Meta; body: string; raw: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: content, raw: '' }
  const meta: Meta = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1]] = unquote(kv[2])
  }
  // Drop the blank line that conventionally follows the closing fence; joinFrontMatter restores it.
  return { meta, body: content.slice(m[0].length).replace(/^\n/, ''), raw: m[1] }
}

/** A change to front-matter: null removes the key. */
export type MetaPatch = Record<string, string | null>

export function applyPatch(meta: Meta, patch: MetaPatch): Meta {
  const next = { ...meta }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k]
    else next[k] = v
  }
  return next
}

export function joinFrontMatter(raw: string, meta: Meta, body: string) {
  let lines = raw ? raw.split('\n') : []
  // Keys Ekdanta removed (say, an un-starred exemplar) go; anything it doesn't parse stays.
  lines = lines.filter((l) => {
    const key = l.match(/^([A-Za-z_][\w-]*):/)?.[1]
    return !key || key in meta
  })
  for (const [key, value] of Object.entries(meta)) {
    const i = lines.findIndex((l) => l.startsWith(key + ':'))
    const line = `${key}: ${yamlValue(value)}`
    if (i >= 0) {
      if (unquote(lines[i].slice(key.length + 1).trim()) !== value) lines[i] = line
    } else lines.push(line)
  }
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n${body}` : body
}

/** Quote a value only when plain YAML would misread it (a colon, a leading quote or symbol). */
function yamlValue(value: string) {
  if (value === '' || !/(: |\s#|^[\s"'`!&*?|>%@{}[\],-]|\s$)/.test(value)) return value
  return JSON.stringify(value)
}

function unquote(v: string) {
  if (/^".*"$/.test(v)) {
    try {
      return JSON.parse(v) as string
    } catch {
      /* fall through */
    }
  }
  return v.replace(/^["']|["']$/g, '')
}
