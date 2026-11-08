import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { HttpError, isLocalRequest, isLoopbackAddress, isSameOrigin, local, readJson, runTool, statusOf, which } from './net.ts'

const req = (remoteAddress: string | undefined, headers: Record<string, string>, method?: string) => ({ method, socket: { remoteAddress }, headers })

test('loopback addresses', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a)
  for (const a of ['10.0.0.2', '100.101.102.103', '::ffff:192.168.1.4', 'fe80::1', '', undefined]) assert.equal(isLoopbackAddress(a), false, String(a))
})

test('the app itself, on this machine, is local', () => {
  assert.equal(isLocalRequest(req('127.0.0.1', { host: '127.0.0.1:5317' })), true)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317', origin: 'http://localhost:5317' })), true)
  assert.equal(isLocalRequest(req('::1', { host: '[::1]:5317', origin: 'http://[::1]:5317' })), true)
  assert.equal(isLocalRequest(req('::ffff:127.0.0.1', { host: 'ekdanta.localhost:5317' })), true)
})

test('a tailnet host is refused, even through a proxy on loopback', () => {
  // `tailscale serve` connects from loopback but keeps the browser's Host and Origin.
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'laptop.example', origin: 'https://laptop.example' })), false)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'laptop.example' })), false)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317', 'x-forwarded-for': '100.64.0.7' })), false)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317', forwarded: 'for=100.64.0.7' })), false)
  assert.equal(isLocalRequest(req('100.64.0.7', { host: '127.0.0.1:5317' })), false)
})

test('another page in the browser is refused', () => {
  assert.equal(isLocalRequest(req('127.0.0.1', { host: '127.0.0.1:5317', origin: 'https://evil.example' })), false)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: '127.0.0.1:5317', origin: 'http://127.0.0.1:8080' })), false)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: '127.0.0.1:5317', origin: 'null' })), false)
  // DNS rebinding: a remote name that resolves to 127.0.0.1.
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'rebind.example:5317', origin: 'http://rebind.example:5317' })), false)
  assert.equal(isLocalRequest(req('127.0.0.1', {})), false)
  assert.equal(isLocalRequest({ headers: { host: 'localhost' } }), false)
})

test('another site is refused even without an Origin header', () => {
  // <img src="http://localhost:5317/api/…"> on another site: a GET with no Origin.
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317', 'sec-fetch-site': 'cross-site' }, 'GET')), false)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317', 'sec-fetch-site': 'same-site' }, 'GET')), false)
  // The same, from a browser too old to send Sec-Fetch-Site.
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317' }, 'GET')), false)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317' }, 'HEAD')), false)
  // Sec-Fetch-Site and Origin must both agree.
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317', origin: 'http://localhost:5317', 'sec-fetch-site': 'cross-site' }, 'POST')), false)
  // The app's own requests, a URL typed into the address bar, and a script that says so.
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317', 'sec-fetch-site': 'same-origin' }, 'GET')), true)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317', origin: 'http://localhost:5317', 'sec-fetch-site': 'same-origin' }, 'POST')), true)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317', 'sec-fetch-site': 'none' }, 'GET')), true)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'localhost:5317' }, 'POST')), true)
})

test('the app is answered on whatever host the writer opened, the tailnet included', () => {
  assert.equal(isSameOrigin(req('127.0.0.1', { host: 'localhost:5317', origin: 'http://localhost:5317' }, 'PUT')), true)
  assert.equal(isSameOrigin(req('127.0.0.1', { host: '[::1]:5317', origin: 'http://[::1]:5317' }, 'PUT')), true)
  // Writing from the writer's phone over `tailscale serve` is still the app: local() refuses that
  // host, and routes the whole vault depends on must not.
  const phone = req('100.64.0.7', { host: 'laptop.example', origin: 'https://laptop.example' }, 'PUT')
  assert.equal(isSameOrigin(phone), true)
  assert.equal(isLocalRequest(phone), false)
})

test('another site is refused, whichever host it aims at', () => {
  const sites: Record<string, string>[] = [
    { host: 'localhost:5317', origin: 'https://evil.example' },
    { host: 'localhost:5317', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    { host: 'localhost:5317', origin: 'http://localhost:8080' }, // another port is another origin
    { host: 'localhost:5317', origin: 'null' },
    { host: 'localhost:5317', 'sec-fetch-site': 'cross-site' },
    { host: 'localhost:5317', 'sec-fetch-site': 'same-site' },
    { host: 'laptop.example', origin: 'https://evil.example' },
  ]
  for (const headers of sites) {
    assert.equal(isSameOrigin(req('127.0.0.1', headers, 'PUT')), false, JSON.stringify(headers))
  }
  assert.equal(isSameOrigin({ headers: {} }), false)
})

test("a script on the machine is the writer's own; an old browser's <img> is not", () => {
  assert.equal(isSameOrigin(req('127.0.0.1', { host: 'localhost:5317' }, 'POST')), true)
  assert.equal(isSameOrigin(req('127.0.0.1', { host: 'localhost:5317', 'sec-fetch-site': 'none' }, 'GET')), true)
  assert.equal(isSameOrigin(req('127.0.0.1', { host: 'localhost:5317' }, 'GET')), false)
  assert.equal(isSameOrigin(req('127.0.0.1', { host: 'localhost:5317' }, 'HEAD')), false)
})

test('local() lets this machine through and answers anyone else with 403', async () => {
  const route = local(async (r: { headers: Record<string, string> }, url: URL) => `ran ${url.pathname}`)
  const url = new URL('http://localhost:5317/api/reveal')
  assert.equal(await route(req('127.0.0.1', { host: 'localhost:5317', origin: 'http://localhost:5317' }, 'POST'), url), 'ran /api/reveal')
  for (const r of [req('127.0.0.1', { host: 'laptop.example', origin: 'https://laptop.example' }, 'POST'), req('127.0.0.1', { host: 'localhost:5317', 'sec-fetch-site': 'cross-site' }, 'GET')]) {
    let err: unknown
    try {
      await route(r, url)
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof HttpError)
    assert.equal(statusOf(err), 403)
    assert.equal((err as Error).message, 'Only available on this computer')
  }
  assert.equal(statusOf(new Error('boom')), 500)
})

test('runTool passes arguments without a shell', async () => {
  const tricky = 'a "quoted" $(echo no) `x`; rm -rf ~ name.md'
  const { stdout } = await runTool(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', tricky])
  assert.equal(stdout, tricky)
  await assert.rejects(runTool(process.execPath, ['-e', 'process.exit(3)']))
  await assert.rejects(runTool(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 }), /longer than/)
})

test('which finds installed programs and not missing ones', async () => {
  assert.ok(await which('node'))
  assert.equal(await which('ekdanta-no-such-program'), null)
  assert.equal(await which(''), null)
  assert.equal(await which(process.execPath), process.execPath)
})

test('a character split across body chunks survives', async () => {
  const bytes = Buffer.from(JSON.stringify({ content: 'a “quote” — नमस्ते' }))
  // Cut inside every multi-byte character: each cut lands mid-sequence at least once.
  for (let cut = 1; cut < bytes.length; cut++) {
    const chunks = [bytes.subarray(0, cut), bytes.subarray(cut)]
    async function* req() {
      yield* chunks
    }
    assert.deepEqual(await readJson(req()), { content: 'a “quote” — नमस्ते' }, `cut at ${cut}`)
  }
  assert.deepEqual(await readJson((async function* () {})()), {})
})

test('a large body over HTTP keeps every character', async () => {
  const content = '“é—” नमस्ते '.repeat(15000) // ~330 KB, many socket reads
  const server = http.createServer(async (req, res) => res.end(JSON.stringify(await readJson<{ content: string }>(req))))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'PUT', body: JSON.stringify({ content }) })
    const got = (await res.json()) as { content: string }
    assert.equal(got.content.includes('\uFFFD'), false)
    assert.equal(got.content, content)
  } finally {
    server.close()
  }
})
