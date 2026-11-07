// Saving the open document safely. The Saver owns everything between a keystroke and the disk:
// the autosave pause, one save at a time, a save that fails (retried, and mirrored to this browser
// so nothing typed is lost), a save the disk refuses because the file changed (a conflict), and a
// file that has gone. It knows nothing of React or the DOM, so it can be tested on its own.
import { applyPatch, createPatch, diffChars } from 'diff'

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'failed' | 'conflict' | 'gone'

/** Waits before each retry of a failed save; the last one repeats. */
export const RETRY_DELAYS = [1000, 2000, 5000, 10000]
export const retryDelay = (attempt: number) => RETRY_DELAYS[Math.min(Math.max(attempt, 0), RETRY_DELAYS.length - 1)]

// ---- Drafts kept in this browser ---------------------------------------------------------------
// While a document can't be saved, its latest text is kept in localStorage under its path. It's
// dropped once a save lands; if one is still there when the document opens, the writer is offered it.

export interface Store {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
export interface Draft {
  /** The whole file as it would have been saved, front matter included. */
  content: string
  /** When it was kept (ms). */
  at: number
}

export const draftKey = (path: string) => 'ekdanta:draft:' + path

/** Storage can be missing, full or blocked (a private window): a draft is a safety net, never a reason to fail. */
export function readDraft(store: Store | null | undefined, path: string): Draft | null {
  try {
    const raw = store?.getItem(draftKey(path))
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<Draft>
    return typeof d.content === 'string' && typeof d.at === 'number' ? { content: d.content, at: d.at } : null
  } catch {
    return null
  }
}

export function writeDraft(store: Store | null | undefined, path: string, draft: Draft) {
  try {
    store?.setItem(draftKey(path), JSON.stringify(draft))
  } catch {
    /* no room, or no storage: the save retries all the same */
  }
}

export function dropDraft(store: Store | null | undefined, path: string) {
  try {
    store?.removeItem(draftKey(path))
  } catch {
    /* nothing to do */
  }
}

/** A renamed or moved document takes its draft along. A draft already at the new path is kept if it's newer. */
export function moveDraft(store: Store | null | undefined, from: string, to: string) {
  if (from === to) return
  const d = readDraft(store, from)
  if (!d) return
  const there = readDraft(store, to)
  if (!there || there.at < d.at) writeDraft(store, to, d)
  dropDraft(store, from)
}

/** The draft to offer when a document opens, or null. One that matches the disk is dropped without a word. */
export function draftToOffer(store: Store | null | undefined, path: string, disk: string): Draft | null {
  const d = readDraft(store, path)
  if (!d) return null
  if (d.content === disk) {
    dropDraft(store, path)
    return null
  }
  return d
}

// ---- Merging ---------------------------------------------------------------------------------

/**
 * Carry a change made on disk (base → theirs) over to the writer's text (base → mine), line by line.
 * For changes Ekdanta itself makes while the writer types (a relinked [[link]], a new title). Null
 * when the two touch the same lines.
 */
export function rebase(base: string, theirs: string, mine: string): string | null {
  if (theirs === base || theirs === mine) return mine
  if (mine === base) return theirs
  const merged = applyPatch(mine, createPatch('doc', base, theirs, '', '', { context: 1 }))
  // Both changed the same line (typing beside a [[link]] a rename just rewrote): merge it character by character.
  return merged === false ? mergeChars(base, theirs, mine) : merged
}

interface Edit {
  from: number
  to: number
  insert: string
}

/** What turns `base` into `text`, as replacements of ranges of `base`. Null if working it out takes too long. */
function editsOf(base: string, text: string): Edit[] | null {
  const parts = diffChars(base, text, { timeout: 250 })
  if (!parts) return null
  const out: Edit[] = []
  let pos = 0
  for (const part of parts) {
    if (!part.added && !part.removed) {
      pos += part.value.length
      continue
    }
    const last = out[out.length - 1]
    const edit = last && last.to === pos ? last : (out[out.length] = { from: pos, to: pos, insert: '' })
    if (part.added) edit.insert += part.value
    else edit.to = pos += part.value.length
  }
  return out
}

const WORD = /[\p{L}\p{N}_]/u

/** The stretch of `base` an edit touches, widened to whole words: two changes inside one word are one clash. */
function reach(base: string, e: Edit) {
  let from = e.from
  let to = e.to
  while (from > 0 && WORD.test(base[from - 1])) from--
  while (to < base.length && WORD.test(base[to])) to++
  return { from, to }
}

/**
 * A three-way merge by characters: both sides' changes to `base`, if no two of them touch the same
 * word (or insert at the same place). Null otherwise: the writer decides.
 */
export function mergeChars(base: string, theirs: string, mine: string): string | null {
  const a = editsOf(base, theirs)
  const b = editsOf(base, mine)
  if (!a || !b) return null
  // Each side's own edits never clash with each other; only the other side's can.
  const all: Edit[] = [...a]
  for (const e of b) {
    if (a.some((x) => x.from === e.from && x.to === e.to && x.insert === e.insert)) continue // the same change on both sides
    const r = reach(base, e)
    const clash = a.some((x) => {
      const q = reach(base, x)
      return x.from === e.from || (r.from < q.to && q.from < r.to)
    })
    if (clash) return null
    all.push(e)
  }
  let out = base
  for (const e of all.sort((x, y) => y.from - x.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to)
  return out
}

// ---- One operation at a time -----------------------------------------------------------------

/** A queue: each job starts when the one before it has finished, whether it worked or not. */
export function createQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return function run<T>(job: () => Promise<T>): Promise<T> {
    const next = tail.then(job, job)
    tail = next.catch(() => {})
    return next
  }
}

// ---- The saver -------------------------------------------------------------------------------

/** What a failed write tells us: an HTTP status (none for a network failure) and, for a conflict, the disk's version. */
export interface WriteError {
  status?: number
  data?: { mtime?: number; content?: string }
}

export interface SaverDeps {
  write(path: string, content: string, opts: { baseMtime?: number; create?: boolean }): Promise<{ mtime: number }>
  /** The open document's path and text as it would be saved now, or null if none is open. */
  content(): { path: string; content: string } | null
  onState(state: SaveState): void
  /** The file changed on disk since the writer's text was based on it. */
  onConflict(c: { path: string; mtime: number; content: string }): void
  /** The file isn't there any more. */
  onGone(path: string): void
  store?: Store | null
  now?: () => number
  /** Autosave delay after the last edit (ms), or a function giving it (it can change in Settings). */
  delay?: number | (() => number)
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export class Saver {
  state: SaveState = 'saved'
  /** The version on disk the writer's text is based on. */
  base: { path: string; mtime: number; content: string } | null = null
  /** The text has changes the disk doesn't have. */
  dirty = false
  private timer: unknown = undefined
  private retryTimer: unknown = undefined
  private attempt = 0
  private inflight: Promise<void> | null = null
  private paused = 0
  private createNext = false
  private d: Required<Pick<SaverDeps, 'now' | 'delay' | 'setTimer' | 'clearTimer'>> & SaverDeps

  private get delay() {
    return typeof this.d.delay === 'function' ? this.d.delay() : this.d.delay
  }

  constructor(deps: SaverDeps) {
    this.d = {
      now: Date.now,
      delay: 800,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...deps,
    }
  }

  /** A save is waiting, running, or failed: leaving now would lose something. */
  get busy() {
    return this.dirty || this.inflight !== null
  }

  /** A document was read from disk and is now on screen, unchanged. */
  open(path: string, mtime: number, content: string) {
    this.stopTimers()
    this.base = { path, mtime, content }
    this.dirty = false
    this.attempt = 0
    this.createNext = false
    this.set('saved')
  }

  /** Leaving the document: stop saving it. Unsaved text stays in this browser, to be offered next time. */
  close() {
    this.stopTimers()
    if (this.dirty) this.keepDraft()
    this.base = null
    this.dirty = false
    this.set('saved')
  }

  /** The writer changed the text. */
  edited() {
    this.dirty = true
    if (this.state === 'failed' || this.state === 'conflict' || this.state === 'gone') {
      this.keepDraft() // not saved yet: the newest text is the one to keep
      return
    }
    this.set('unsaved')
    this.schedule(this.delay)
  }

  /** Save now if anything is waiting, and wait for saves in flight. True when the disk has everything. */
  async flush(): Promise<boolean> {
    this.clear('timer')
    if (this.inflight) await this.inflight
    if (this.dirty && !this.paused && (this.state === 'unsaved' || this.state === 'failed' || this.state === 'saving')) await this.run()
    return !this.dirty
  }

  /** Wait for a save in flight, without starting one. */
  async settled() {
    while (this.inflight) await this.inflight
  }

  /** The writer asked to try again now. */
  retry() {
    if (this.state !== 'failed') return
    this.clear('retryTimer')
    void this.run()
  }

  /** Hold autosave while a file operation runs (it may move the file from under us). */
  pause() {
    this.paused++
    this.clear('timer')
  }

  resume() {
    this.paused = Math.max(0, this.paused - 1)
    if (!this.paused && this.dirty && (this.state === 'unsaved' || this.state === 'saving')) this.schedule(this.delay)
    if (!this.paused && this.dirty && this.state === 'failed' && this.retryTimer === undefined) this.schedule(retryDelay(this.attempt), 'retryTimer')
  }

  /** The open document now lives at another path (renamed or moved). Its unsaved draft goes with it. */
  retarget(path: string) {
    if (!this.base || this.base.path === path) return
    moveDraft(this.d.store, this.base.path, path)
    this.base = { ...this.base, path }
  }

  /**
   * A new version of the file is on disk and the writer's text is now based on it: after Ekdanta
   * itself changed the file (a relink, a star), or after loading theirs. `clean` says whether the
   * text on screen is exactly that version.
   */
  adopt(mtime: number, content: string, clean: boolean) {
    if (!this.base) return
    this.base = { ...this.base, mtime, content }
    if (clean) {
      this.stopTimers()
      this.dirty = false
      this.attempt = 0
      dropDraft(this.d.store, this.base.path)
      this.set('saved')
    } else {
      this.dirty = true
      if (this.state === 'conflict' || this.state === 'gone' || this.state === 'saved') this.set('unsaved')
      if (this.state === 'unsaved') this.schedule(this.delay)
    }
  }

  /** Conflict: keep the writer's text, written over the version now on disk (`mtime`). */
  keepMine(mtime: number) {
    if (!this.base) return
    this.base = { ...this.base, mtime }
    this.dirty = true
    this.set('unsaved')
    void this.run()
  }

  /** The file was deleted: write it back with the text on screen. */
  recreate() {
    if (!this.base) return
    this.createNext = true
    this.dirty = true
    this.set('unsaved')
    void this.run()
  }

  /** The file changed on disk while the writer has unsaved text (seen by polling). */
  clash(c: { path: string; mtime: number; content: string }) {
    if (!this.base) return
    this.stopTimers()
    this.keepDraft()
    this.set('conflict')
    this.d.onConflict(c)
  }

  /** The file was deleted on disk (seen by polling). */
  gone() {
    if (!this.base) return
    this.stopTimers()
    if (this.dirty) this.keepDraft()
    this.set('gone')
    this.d.onGone(this.base.path)
  }

  /** Keep the newest text in this browser (also called as the page goes away). */
  keepDraft() {
    const now = this.d.content()
    if (now && this.dirty) writeDraft(this.d.store, now.path, { content: now.content, at: this.d.now() })
  }

  private async run(): Promise<void> {
    this.clear('timer')
    if (this.paused) return
    if (this.inflight) {
      // One save at a time: the text is read again when this one is done.
      await this.inflight
      if (this.dirty && !this.paused && this.state !== 'conflict' && this.state !== 'gone') return this.run()
      return
    }
    const snap = this.d.content()
    if (!snap || !this.base) return
    const base = this.base
    const create = this.createNext
    this.set('saving')
    let done!: () => void
    this.inflight = new Promise<void>((r) => (done = r))
    try {
      const { mtime } = await this.d.write(snap.path, snap.content, { baseMtime: base.mtime, create })
      this.createNext = false
      this.attempt = 0
      this.clear('retryTimer')
      if (this.base?.path !== snap.path) {
        // Moved while saving (file operations wait for saves, so this is rare): save again at the new path.
        this.set('unsaved')
        this.schedule(this.delay)
        return
      }
      this.base = { path: snap.path, mtime, content: snap.content }
      if (this.d.content()?.content === snap.content) {
        this.dirty = false
        dropDraft(this.d.store, snap.path)
        this.set('saved')
      } else {
        this.set('unsaved')
        if (this.timer === undefined) this.schedule(this.delay)
      }
    } catch (e) {
      const err = (e ?? {}) as WriteError
      this.keepDraft()
      if (this.base?.path !== snap.path) {
        this.set('unsaved')
        this.schedule(this.delay)
        return
      }
      if (err.status === 409 && typeof err.data?.mtime === 'number' && typeof err.data.content === 'string') {
        this.set('conflict')
        this.d.onConflict({ path: snap.path, mtime: err.data.mtime, content: err.data.content })
      } else if (err.status === 404) {
        this.set('gone')
        this.d.onGone(snap.path)
      } else {
        this.set('failed')
        this.schedule(retryDelay(this.attempt++), 'retryTimer')
      }
    } finally {
      this.inflight = null
      done()
    }
  }

  private schedule(ms: number, which: 'timer' | 'retryTimer' = 'timer') {
    this.clear(which)
    this[which] = this.d.setTimer(() => {
      this[which] = undefined
      void this.run()
    }, ms)
  }

  private clear(which: 'timer' | 'retryTimer') {
    if (this[which] !== undefined) this.d.clearTimer(this[which])
    this[which] = undefined
  }

  private stopTimers() {
    this.clear('timer')
    this.clear('retryTimer')
  }

  private set(state: SaveState) {
    if (this.state === state) return
    this.state = state
    this.d.onState(state)
  }
}
