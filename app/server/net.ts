// Guards for routes that run programs on this machine or write outside the vault. The dev server
// also answers tailnet hosts (`tailscale serve`, see vite.config.ts), which reach it through a proxy
// on loopback, so a loopback address alone isn't enough: the Host the browser asked for, and the
// page that sent the request, must be this machine too.
import { execFile } from 'node:child_process'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'

/** The parts of a request isLocalRequest looks at (an http.IncomingMessage has them). */
export interface RequestLike {
  method?: string
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
 * True for a request the app itself made: from a page on the host it was addressed to, from the
 * address bar, or from a script on this machine — not from another site the writer has open in the
 * same browser, which can otherwise reach the server simply because it is running. The host it was
 * addressed to is whatever the writer opened, so this holds over `tailscale serve` too.
 */
export function isSameOrigin(req: RequestLike): boolean {
  const host = header(req, 'host')
  if (!host) return false
  // Browsers say whether the request comes from another site. Origin alone isn't enough: they
  // leave it off a cross-site GET (an <img>, a link, a navigation).
  const site = header(req, 'sec-fetch-site')
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const origin = header(req, 'origin')
  if (origin === undefined) {
    // A GET with neither header could be another site's <img> in a browser too old to send
    // Sec-Fetch-Site. Other methods carry Origin whenever a page sends them.
    return site !== undefined || !/^(GET|HEAD)$/i.test(req.method ?? '')
  }
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase()
  } catch {
    return false // "null" (a sandboxed frame or a file://) or garbage
  }
}

/**
 * True only for a request made on this machine, to this machine: from a loopback address, not
 * forwarded by a proxy, addressed to a loopback host name, and from a page on that same host (or
 * typed into the address bar). A GET must show that with Origin or Sec-Fetch-Site, which every
 * current browser sends; a script on this machine can send `Sec-Fetch-Site: none`.
 */
export function isLocalRequest(req: RequestLike): boolean {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  if (header(req, 'x-forwarded-for') || header(req, 'x-forwarded-host') || header(req, 'forwarded')) return false
  const host = header(req, 'host')
  if (!host || !isLoopbackHost(host)) return false
  return isSameOrigin(req)
}

/** An error with an HTTP status, for the API router to answer with. */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The status the API answers a failed request with: an HttpError's own, otherwise 500. */
export const statusOf = (e: unknown) => (e instanceof HttpError ? e.status : 500)

/**
 * Wrap a route so it answers only requests made on this machine (not over the tailnet, not from
 * another site): for routes that run programs or write outside the vault. Others get a 403.
 */
export const local =
  <Req extends RequestLike, Rest extends unknown[], R>(handler: (req: Req, ...rest: Rest) => R) =>
  (req: Req, ...rest: Rest): R => {
    if (!isLocalRequest(req)) throw new HttpError(403, 'Only available on this computer')
    return handler(req, ...rest)
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
