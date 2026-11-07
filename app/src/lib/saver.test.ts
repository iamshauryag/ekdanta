// The save pipeline without a browser: failures and retries, conflicts, gone files, drafts and rebasing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Saver, createQueue, draftKey, draftToOffer, mergeChars, moveDraft, readDraft, rebase, retryDelay, type SaveState, type Store } from './saver.ts'

class MemStore implements Store {
  map = new Map<string, string>()
  getItem = (k: string) => this.map.get(k) ?? null
  setItem = (k: string, v: string) => void this.map.set(k, v)
  removeItem = (k: string) => void this.map.delete(k)
}

/** A saver with hand-driven timers and a fake disk. */
function rig(opts: { fail?: () => unknown } = {}) {
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let id = 0
  const store = new MemStore()
  const states: SaveState[] = []
  const disk = new Map<string, { content: string; mtime: number }>()
  let clock = 1000
  const doc = { path: 'a.md', content: 'one' }
  const events: string[] = []
  const writes: { path: string; content: string; baseMtime?: number; create?: boolean }[] = []
  const saver = new Saver({
    write: async (path, content, o) => {
      writes.push({ path, content, ...o })
      await Promise.resolve()
      const err = opts.fail?.()
      if (err) throw err
      const cur = disk.get(path)
      if (!cur && !o.create) throw { status: 404 }
      if (cur && o.baseMtime !== undefined && cur.mtime !== o.baseMtime && cur.content !== content) throw { status: 409, data: cur }
      const mtime = ++clock
      disk.set(path, { content, mtime })
      return { mtime }
    },
    content: () => ({ ...doc }),
    onState: (s) => states.push(s),
    onConflict: (c) => events.push('conflict:' + c.content),
    onGone: (p) => events.push('gone:' + p),
    store,
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.set(++id, { fn, ms })
      return id
    },
    clearTimer: (t) => void timers.delete(t as number),
  })
  /** Fire the pending timers (the next one only, or all with the given delay). */
  const tick = async () => {
    const [[k, t]] = [...timers]
    timers.delete(k)
    t.fn()
    await settle()
    return t.ms
  }
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await saver.settled()
  }
  disk.set('a.md', { content: 'one', mtime: 1 })
  saver.open('a.md', 1, 'one')
  return { saver, store, states, disk, doc, events, writes, timers, tick, settle }
}

test('retries back off at 1, 2, 5 and 10 seconds, then keep trying every 10', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(retryDelay), [1000, 2000, 5000, 10000, 10000, 10000])
})

test('an edit autosaves after a pause and drops nothing', async () => {
  const r = rig()
  r.doc.content = 'two'
  r.saver.edited()
  assert.equal(r.saver.state, 'unsaved')
  assert.equal(r.saver.busy, true)
  assert.equal(await r.tick(), 800)
  assert.equal(r.disk.get('a.md')?.content, 'two')
  assert.equal(r.writes[0].baseMtime, 1)
  assert.equal(r.saver.state, 'saved')
  assert.equal(r.saver.busy, false)
})

test('a failed save keeps the text in the browser, retries, and clears it once saved', async () => {
  let down = true
  const r = rig({ fail: () => (down ? new TypeError('Failed to fetch') : null) })
  r.doc.content = 'typed while offline'
  r.saver.edited()
  await r.tick()
  assert.equal(r.saver.state, 'failed')
  assert.equal(r.saver.dirty, true)
  assert.equal(readDraft(r.store, 'a.md')?.content, 'typed while offline')
  // Typing goes on: the draft follows, and the retry schedule isn't reset by each key.
  r.doc.content = 'typed while offline, more'
  r.saver.edited()
  assert.equal(readDraft(r.store, 'a.md')?.content, 'typed while offline, more')
  assert.equal(await r.tick(), 1000)
  assert.equal(await r.tick(), 2000)
  assert.equal(await r.tick(), 5000)
  down = false
  assert.equal(await r.tick(), 10000)
  assert.equal(r.saver.state, 'saved')
  assert.equal(r.disk.get('a.md')?.content, 'typed while offline, more')
  assert.equal(readDraft(r.store, 'a.md'), null)
  assert.equal(r.timers.size, 0)
})

test('flush on a failing save resolves false instead of throwing, and close keeps the draft', async () => {
  const r = rig({ fail: () => new TypeError('Failed to fetch') })
  r.doc.content = 'unsaved'
  r.saver.edited()
  assert.equal(await r.saver.flush(), false)
  r.saver.close()
  assert.equal(r.timers.size, 0, 'no retries for a document that is no longer open')
  assert.equal(readDraft(r.store, 'a.md')?.content, 'unsaved')
})

test('a 409 raises a conflict with their version; keep mine writes over it', async () => {
  const r = rig()
  r.disk.set('a.md', { content: 'theirs', mtime: 50 })
  r.doc.content = 'mine'
  r.saver.edited()
  await r.tick()
  assert.equal(r.saver.state, 'conflict')
  assert.deepEqual(r.events, ['conflict:theirs'])
  assert.equal(r.disk.get('a.md')?.content, 'theirs')
  // No autosave hammers the conflict while the writer decides.
  r.doc.content = 'mine, still'
  r.saver.edited()
  assert.equal(r.timers.size, 0)
  r.saver.keepMine(50)
  await r.settle()
  assert.equal(r.disk.get('a.md')?.content, 'mine, still')
  assert.equal(r.saver.state, 'saved')
})

test('a gone file is not recreated until asked', async () => {
  const r = rig()
  r.disk.delete('a.md')
  r.doc.content = 'still here'
  r.saver.edited()
  await r.tick()
  assert.equal(r.saver.state, 'gone')
  assert.deepEqual(r.events, ['gone:a.md'])
  assert.equal(r.disk.has('a.md'), false)
  r.saver.recreate()
  await r.settle()
  assert.equal(r.disk.get('a.md')?.content, 'still here')
  assert.equal(r.writes.at(-1)?.create, true)
  assert.equal(r.saver.state, 'saved')
})

test('paused autosave waits for the file operation, then saves at the new path', async () => {
  const r = rig()
  await r.saver.flush()
  r.saver.pause()
  r.doc.content = 'typed during a rename'
  r.saver.edited()
  assert.equal(r.timers.size, 1)
  await r.tick() // the autosave fires, but the operation is still running
  assert.equal(r.writes.length, 0)
  r.disk.set('b.md', r.disk.get('a.md')!)
  r.disk.delete('a.md')
  r.doc.path = 'b.md'
  r.saver.retarget('b.md')
  r.saver.resume()
  await r.tick()
  assert.equal(r.disk.has('a.md'), false, 'the old name is not brought back')
  assert.equal(r.disk.get('b.md')?.content, 'typed during a rename')
})

test('a draft follows a rename', () => {
  const store = new MemStore()
  store.setItem(draftKey('a.md'), JSON.stringify({ content: 'x', at: 5 }))
  moveDraft(store, 'a.md', 'b.md')
  assert.equal(readDraft(store, 'a.md'), null)
  assert.equal(readDraft(store, 'b.md')?.content, 'x')
  // A newer draft already at the new path wins.
  store.setItem(draftKey('c.md'), JSON.stringify({ content: 'old', at: 1 }))
  store.setItem(draftKey('d.md'), JSON.stringify({ content: 'new', at: 9 }))
  moveDraft(store, 'c.md', 'd.md')
  assert.equal(readDraft(store, 'd.md')?.content, 'new')
})

test('a draft equal to the disk is dropped silently; a different one is offered', () => {
  const store = new MemStore()
  store.setItem(draftKey('a.md'), JSON.stringify({ content: 'same', at: 5 }))
  assert.equal(draftToOffer(store, 'a.md', 'same'), null)
  assert.equal(store.map.size, 0)
  store.setItem(draftKey('a.md'), JSON.stringify({ content: 'newer', at: 5 }))
  assert.equal(draftToOffer(store, 'a.md', 'same')?.content, 'newer')
  // Junk, or storage that throws, is no draft at all.
  store.setItem(draftKey('j.md'), '{not json')
  assert.equal(readDraft(store, 'j.md'), null)
  const broken: Store = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
    removeItem: () => {
      throw new Error('blocked')
    },
  }
  assert.equal(draftToOffer(broken, 'a.md', 'x'), null)
  assert.doesNotThrow(() => moveDraft(broken, 'a.md', 'b.md'))
})

test('rebase carries a relinked line into text typed meanwhile, even on the same line, and gives up on a clash', () => {
  const base = 'title: A\n\nSee [[b]].\n\nSecond paragraph.\n'
  const theirs = 'title: A\n\nSee [[c]].\n\nSecond paragraph.\n'
  const mine = 'title: A\n\nSee [[b]].\n\nSecond paragraph, longer now.\n'
  assert.equal(rebase(base, theirs, mine), 'title: A\n\nSee [[c]].\n\nSecond paragraph, longer now.\n')
  assert.equal(rebase(base, theirs, base), theirs)
  assert.equal(rebase(base, base, mine), mine)
  // Typing on the line the rename rewrote: the two changes touch different characters.
  assert.equal(rebase(base, theirs, 'title: A\n\nSee [[b]] and more.\n\nSecond paragraph.\n'), 'title: A\n\nSee [[c]] and more.\n\nSecond paragraph.\n')
  // The writer changed the very link the rename rewrote: theirs to choose.
  assert.equal(rebase(base, theirs, 'title: A\n\nSee [[bee]].\n\nSecond paragraph.\n'), null)
  assert.equal(rebase(base, theirs, 'title: A\n\nSee [[d]].\n\nSecond paragraph.\n'), null)
})

test('mergeChars applies both sides when they touch different text, and refuses inserts at one place', () => {
  assert.equal(mergeChars('one two three', 'one 2 three', 'one two three four'), 'one 2 three four')
  assert.equal(mergeChars('one two', 'one two!', 'one two?'), null)
  assert.equal(mergeChars('abc', 'abc', 'abc'), 'abc')
  // The same change on both sides is made once.
  assert.equal(mergeChars('a b c', 'a B c', 'a B c!'), 'a B c!')
  // A rename rewrites a whole word in several pieces; typing elsewhere on the line still merges.
  assert.equal(mergeChars('See [[target]] here', 'See [[aim]] here', 'See [[target]] here, too'), 'See [[aim]] here, too')
})

test('the queue runs one job at a time, in order, past failures', async () => {
  const run = createQueue()
  const log: string[] = []
  const job =
    (name: string, ms: number, fail = false) =>
    () =>
      new Promise<string>((res, rej) =>
        setTimeout(() => {
          log.push(name)
          fail ? rej(new Error(name)) : res(name)
        }, ms),
      )
  const a = run(job('a', 20))
  const b = run(job('b', 1, true))
  const c = run(job('c', 1))
  assert.equal(await a, 'a')
  await assert.rejects(b, /b/)
  assert.equal(await c, 'c')
  assert.deepEqual(log, ['a', 'b', 'c'])
})

test('the autosave delay is read at each edit, so a change in Settings applies at once', () => {
  let ms = 800
  const waits: number[] = []
  const saver = new Saver({
    write: async () => ({ mtime: 2 }),
    content: () => ({ path: 'a.md', content: 'x' }),
    onState: () => {},
    onConflict: () => {},
    onGone: () => {},
    delay: () => ms,
    setTimer: (_fn, wait) => waits.push(wait),
    clearTimer: () => {},
  })
  saver.open('a.md', 1, '')
  saver.edited()
  ms = 3000
  saver.edited()
  assert.deepEqual(waits, [800, 3000])
})
