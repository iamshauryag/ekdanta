import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Refused, getPublic, hextets, isPublicAddress } from './outbound.ts'

test('every spelling of a local or private address is refused', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.100.100.100',
    '0.0.0.0',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '[::ffff:127.0.0.1]',
    '::ffff:7f00:1', // how a URL writes [::ffff:127.0.0.1]
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:a9fe:a9fe', // 169.254.169.254
    '::ffff:0:7f00:1',
    '::127.0.0.1',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::192.168.0.1',
    '2002:7f00:1::',
    '2002:c0a8:101::1',
    '2001:0:4136:e378::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%en0',
    'ff02::1',
    '2001:db8::1',
    'not an address',
  ])
    assert.equal(isPublicAddress(ip), false, ip)
})

test('public addresses, both families, are allowed', () => {
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) assert.equal(isPublicAddress(ip), true, ip)
})

test('IPv6 addresses are read in full', () => {
  assert.deepEqual(hextets('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
  assert.deepEqual(hextets('fe80::1'), [0xfe80, 0, 0, 0, 0, 0, 0, 1])
  assert.equal(hextets('1.2.3.4'), null)
})

test('a lookup never connects to this machine, however the host is written', async (t) => {
  let hits = 0
  const server = http.createServer((_req, res) => {
    hits++
    res.end('secret')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const port = (server.address() as { port: number }).port
  for (const host of ['127.0.0.1', 'localhost', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]']) {
    const url = new URL(`http://${host}:${port}/`)
    await assert.rejects(getPublic(url, { headers: {}, signal: AbortSignal.timeout(2000), maxBytes: 1000 }), Refused, host)
  }
  assert.equal(hits, 0)
})
