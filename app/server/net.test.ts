import test from 'node:test'
import assert from 'node:assert/strict'
import { isLocalRequest, isLoopbackAddress, runTool, which } from './net.ts'

const req = (remoteAddress: string | undefined, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers })

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
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'mac.tail1234.ts.net', origin: 'https://mac.tail1234.ts.net' })), false)
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'mac.tail1234.ts.net' })), false)
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
