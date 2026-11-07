// Fetching a public web page for the writer, and nothing else. A lookup must never reach this
// machine, the local network or the tailnet, however the address is spelled: an IPv4 address
// written as IPv6 (::ffff:127.0.0.1, which a URL turns into ::ffff:7f00:1), NAT64 or 6to4 forms,
// a host name that resolves to a private address, or one that resolves differently a second time.
// So every address is checked at the moment the connection is made, not beforehand.
import http from 'node:http'
import https from 'node:https'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import net from 'node:net'

/** IPv4 ranges that aren't the public internet. */
const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, and the tailnet
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3], // multicast and reserved, up to 255.255.255.255
]
const blockedV4 = new net.BlockList()
for (const [a, bits] of PRIVATE_V4) blockedV4.addSubnet(a, bits, 'ipv4')

/** An IPv6 address as eight 16-bit numbers, or null if it isn't one. */
export function hextets(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (!net.isIPv6(s)) return null
  // A dotted IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number)
    s = s.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, rest] = s.split('::')
  const part = (x: string | undefined) => (x ? x.split(':').map((h) => parseInt(h, 16)) : [])
  const front = part(head)
  const back = part(rest)
  const zeros = rest === undefined ? 0 : 8 - front.length - back.length
  const out = [...front, ...Array(zeros).fill(0), ...back]
  return out.length === 8 && out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

/** True only for an address on the public internet. Anything unreadable counts as private. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (net.isIPv4(bare)) return !blockedV4.check(bare, 'ipv4')
  const h = hextets(bare)
  if (!h) return false
  const zero = (n: number) => h.slice(0, n).every((x) => x === 0)
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (translated) carry an IPv4 address.
  if (zero(5) && h[5] === 0xffff) return isPublicAddress(v4Of(h[6], h[7]))
  if (zero(4) && h[4] === 0xffff && h[5] === 0) return isPublicAddress(v4Of(h[6], h[7]))
  // ::, ::1 and the old IPv4-compatible ::a.b.c.d.
  if (zero(6)) return false
  // NAT64 (64:ff9b::a.b.c.d) reaches the IPv4 address it carries; 64:ff9b:1::/48 is local use.
  if (h[0] === 0x64 && h[1] === 0xff9b) return h.slice(2, 6).every((x) => x === 0) && isPublicAddress(v4Of(h[6], h[7]))
  // 6to4 (2002:aabb:ccdd::) carries one in its second and third hextets.
  if (h[0] === 0x2002) return isPublicAddress(v4Of(h[1], h[2]))
  // Teredo (2001:0::/32) hides one; documentation (2001:db8::/32) is never real.
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) return false
  if (h[0] === 0x100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return false // discard-only
  if ((h[0] & 0xfe00) === 0xfc00) return false // unique local
  if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return false // link- and site-local
  if ((h[0] & 0xff00) === 0xff00) return false // multicast
  return true
}

/** Why a request was refused, for the writer. */
export class Refused extends Error {
  code = 'EREFUSED_PRIVATE'
}

type LookupOptions = { family?: number | string; all?: boolean; hints?: number }
type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void

/** dns.lookup for the connection itself: every address the name resolves to must be public. */
export function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback) {
  dnsLookup(hostname, { ...options, all: true } as { all: true }, (err, addrs) => {
    if (err) return callback(err)
    if (!addrs.length) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }))
    if (addrs.some((a) => !isPublicAddress(a.address))) return callback(new Refused(hostname))
    if (options.all) callback(null, addrs)
    else callback(null, addrs[0].address, addrs[0].family)
  })
}

export interface Fetched {
  status: number
  location: string | null
  body: Buffer
}

/**
 * One GET to a public http(s) address, no redirects followed (the caller checks each hop), the body
 * cut off at `maxBytes`. Rejects with Refused for an address that isn't public.
 */
export function getPublic(url: URL, opts: { headers: Record<string, string>; signal: AbortSignal; maxBytes: number }): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new Refused(url.protocol))
    // An address written into the URL is never looked up, so check it here.
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (net.isIP(host) && !isPublicAddress(host)) return reject(new Refused(host))
    const get = url.protocol === 'https:' ? https.get : http.get
    const req = get(url, { headers: { ...opts.headers, 'accept-encoding': 'identity' }, signal: opts.signal, lookup: publicLookup as never, agent: false }, (res) => {
      const status = res.statusCode ?? 0
      const location = typeof res.headers.location === 'string' ? res.headers.location : null
      if (status >= 300 && status < 400) {
        res.resume()
        return resolve({ status, location, body: Buffer.alloc(0) })
      }
      const chunks: Buffer[] = []
      let size = 0
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve({ status, location, body: Buffer.concat(chunks) })
      }
      res.on('data', (c: Buffer) => {
        chunks.push(c)
        size += c.length
        if (size > opts.maxBytes) {
          finish()
          res.destroy()
        }
      })
      res.on('end', finish)
      res.on('error', (e) => (done ? undefined : reject(e)))
    })
    req.on('error', reject)
  })
}
