// Safari before 16.4 cannot parse regex lookbehind. One inside a regex literal is a syntax error for
// the whole bundle, so the app shows a blank page; build targets don't help (esbuild only turns the
// literal into `new RegExp`, which moves the crash to run time). Client code must not use it. The
// server runs in Node and is not checked. Use splitAfter (lib/split.ts) or a capture group instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('.', import.meta.url))
const LOOKBEHIND = /\(\?<[=!]/

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) yield path
  }
}

test('no regex lookbehind in client code', () => {
  const found: string[] = []
  for (const file of sourceFiles(SRC)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (LOOKBEHIND.test(line)) found.push(`${file.slice(SRC.length)}:${i + 1}: ${line.trim()}`)
      })
  }
  assert.deepEqual(found, [], 'Lookbehind blanks the page on Safari before 16.4:\n' + found.join('\n'))
})

test('the check itself spots a lookbehind', () => {
  assert.ok(LOOKBEHIND.test('x.split(/(?<=[.!?])\\s+/)'))
  assert.ok(LOOKBEHIND.test("new RegExp('(?<!a)b')"))
  assert.ok(!LOOKBEHIND.test('/(?<name>a)/'))
})
