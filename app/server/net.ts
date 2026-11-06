// Guards for routes that run programs on this machine or write outside the vault. The dev server
// also answers tailnet hosts (`tailscale serve`, see vite.config.ts), which reach it through a proxy
// on loopback, so a loopback address alone isn't enough: the Host the browser asked for, and the
// page that sent the request, must be this machine too.
import { execFile } from 'node:child_process'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'

/** The parts of a request isLocalRequest looks at (an http.IncomingMessage has them). */
export interface RequestLike {
  socket?: { remoteAddress?: string } | null
  headers: Record<string, string | string[] | undefined>
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.replace(/^::ffff:/i, '')
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

/** "localhost:5317" → "localhost"; "[::1]:5317" → "[::1]". */
function hostname(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1)
  return h.replace(/:\d+$/, '')
}

const isLoopbackHost = (host: string) => {
  const h = hostname(host)
  return LOOPBACK_HOSTS.has(h) || isLoopbackAddress(h) || h.endsWith('.localhost')
}

const header = (req: RequestLike, name: string) => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * True only for a request made on this machine, to this machine: from a loopback address, not
 * forwarded by a proxy, addressed to a loopback host name, and (when the browser says which page
 * sent it) from a page on that same host.
 */
export function isLocalRequest(req: RequestLike): boolean {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  if (header(req, 'x-forwarded-for') || header(req, 'x-forwarded-host') || header(req, 'forwarded')) return false
  const host = header(req, 'host')
  if (!host || !isLoopbackHost(host)) return false
  const origin = header(req, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase()
  } catch {
    return false // "null" (a sandboxed frame or a file://) or garbage
  }
}

export interface ToolResult {
  stdout: string
  stderr: string
}

/**
 * Run a program with an argument array: never through a shell, so a vault path with spaces,
 * quotes or `$(…)` in it is only ever an argument. Rejects on a non-zero exit or the timeout.
 */
export function runTool(cmd: string, args: string[], opts: { timeoutMs?: number; cwd?: string; maxBuffer?: number } = {}): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { shell: false, timeout: opts.timeoutMs ?? 30_000, cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { stderr?: string; killed?: boolean }
        e.stderr = String(stderr)
        if (e.killed) e.message = `${cmd} took longer than ${Math.round((opts.timeoutMs ?? 30_000) / 1000)} s`
        reject(e)
      } else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Where a program is on the PATH, like `which`, or null if it isn't installed. */
export async function which(cmd: string): Promise<string | null> {
  if (!cmd || /[\\/]/.test(cmd)) {
    if (!cmd) return null
    return (await fs.access(cmd, constants.X_OK).then(
      () => true,
      () => false,
    ))
      ? path.resolve(cmd)
      : null
  }
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, cmd + ext)
      if (
        await fs.access(file, constants.X_OK).then(
          () => true,
          () => false,
        )
      )
        return file
    }
  }
  return null
}
