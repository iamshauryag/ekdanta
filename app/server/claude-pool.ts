// Warm Claude Code CLI sessions, so a help request doesn't pay the CLI's start-up and wrap-up
// time. Each session reads requests as stream-json on stdin. We answer as soon as the model's
// text arrives instead of waiting for the CLI's end-of-turn event, which comes ~2s later.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import readline from 'node:readline'

const ENGINE_PROMPT = `You are the text engine of Ekdanta, a writing app.
Every user message is a separate, independent request: it carries its own instructions in <instructions> and its own material. Ignore all earlier messages.
Follow the instructions exactly and output only what they ask for.`

const MAX_TURNS = 30 // recycle before the running conversation grows
const MAX_SESSIONS = 3 // per model
const IDLE_MS = 10 * 60_000
const TURN_TIMEOUT_MS = 90_000

interface Pending {
  resolve: (text: string) => void
  reject: (e: Error) => void
  answered: boolean
  timer: NodeJS.Timeout
}

class Session {
  private child: ChildProcessWithoutNullStreams
  private pending: Pending | null = null
  private turns = 0
  private idle: NodeJS.Timeout | undefined
  dead = false

  constructor(
    readonly model: string,
    effort: string,
    private onFree: () => void,
  ) {
    this.child = spawn(
      'claude',
      [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--model', model,
        '--effort', effort,
        '--tools', '',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--system-prompt', ENGINE_PROMPT,
      ],
      { cwd: os.tmpdir(), env: process.env },
    )
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line))
    let stderr = ''
    this.child.stderr.setEncoding('utf8') // whole characters, even when one spans two reads
    this.child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-500)))
    this.child.on('close', () => {
      this.dead = true
      this.pending?.reject(new Error(stderr.trim().split('\n').pop() || 'Claude CLI session ended'))
      this.finish()
    })
    this.child.on('error', (e) => {
      this.dead = true
      this.pending?.reject(e)
      this.finish()
    })
    this.armIdle()
  }

  get busy() {
    return this.pending !== null
  }

  get worn() {
    return this.turns >= MAX_TURNS
  }

  ask(text: string): Promise<string> {
    if (this.busy || this.dead) return Promise.reject(new Error('Session not available'))
    this.turns++
    clearTimer(this.idle)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Claude CLI timed out'))
        this.kill()
      }, TURN_TIMEOUT_MS)
      this.pending = { resolve, reject, answered: false, timer }
      this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    })
  }

  private onLine(line: string) {
    let event: { type?: string; message?: { content?: { type: string; text?: string }[] }; is_error?: boolean; result?: string }
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    const p = this.pending
    if (!p) return
    if (event.type === 'assistant' && !p.answered) {
      const text = (event.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
      if (text) {
        // The answer is here; the CLI's wrap-up can finish in the background.
        p.answered = true
        p.resolve(text)
      }
    } else if (event.type === 'result') {
      if (!p.answered) {
        if (event.is_error || typeof event.result !== 'string') p.reject(new Error(event.result || 'Claude CLI error'))
        else p.resolve(event.result)
      }
      this.finish()
    }
  }

  private finish() {
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = null
    if (this.worn) this.kill()
    else this.armIdle()
    this.onFree()
  }

  private armIdle() {
    clearTimer(this.idle)
    this.idle = setTimeout(() => this.kill(), IDLE_MS)
  }

  kill() {
    clearTimer(this.idle)
    if (!this.dead) {
      this.dead = true
      this.child.kill()
    }
  }
}

function clearTimer(t: NodeJS.Timeout | undefined) {
  if (t) clearTimeout(t)
}

/**
 * A small pool per model. Two sessions stay warm so back-to-back requests don't wait for the
 * CLI's wrap-up; under a burst it grows to MAX_SESSIONS, then requests wait for a free one.
 */
class Pool {
  private sessions: Session[] = []
  private waiters: (() => void)[] = []
  constructor(
    readonly model: string,
    readonly effort: string,
    readonly size = 2,
  ) {}

  private spawn() {
    const s = new Session(this.model, this.effort, () => this.waiters.shift()?.())
    this.sessions.push(s)
    return s
  }

  warm() {
    this.sessions = this.sessions.filter((s) => !s.dead && !s.worn)
    while (this.sessions.length < this.size) this.spawn()
  }

  private async acquire(): Promise<Session> {
    for (;;) {
      this.warm()
      const free = this.sessions.find((s) => !s.busy && !s.dead)
      if (free) return free
      if (this.sessions.length < MAX_SESSIONS) return this.spawn()
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  async ask(text: string): Promise<string> {
    const session = await this.acquire()
    try {
      return await session.ask(text)
    } finally {
      // Replace any session that ended or wore out, ready for the next request.
      setTimeout(() => this.warm(), 0)
    }
  }

  close() {
    for (const s of this.sessions) s.kill()
    this.sessions = []
    for (const w of this.waiters.splice(0)) w()
  }
}

const pools = new Map<string, Pool>()

export function claudePool(model: string, effort = 'low') {
  const key = `${model}:${effort}`
  let pool = pools.get(key)
  if (!pool) pools.set(key, (pool = new Pool(model, effort)))
  return pool
}

export function askClaude(model: string, effort: string, instructions: string, prompt: string) {
  return claudePool(model, effort).ask(`<instructions>\n${instructions}\n</instructions>\n\n${prompt}`)
}

export function closeClaudePools() {
  for (const p of pools.values()) p.close()
  pools.clear()
}

process.once('exit', closeClaudePools)
