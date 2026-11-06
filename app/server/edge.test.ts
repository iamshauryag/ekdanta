import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.EKDANTA_FAKE_MODEL = '1'
const { runEdge, fakeCandidates } = await import('./edge.ts')
const { NOTHING_FITS, TOO_SHORT, inDraft } = await import('../src/lib/edge.ts')

const EMAIL = `Thanks for meeting with us on Monday. We went through the pilot results with the whole team. The numbers held up across all three sites. We would like to start the rollout in March. Could you confirm the contract terms by Friday?`

test('the fake model invents a $5M line, and the guards drop it', async () => {
  assert.ok(fakeCandidates(EMAIL).some((c) => c.text.includes('$5M')))
  const r = await runEdge({ slot: 'subject', text: EMAIL, kind: 'email' })
  assert.equal(r.kind, 'edge')
  if (r.kind !== 'edge') return
  assert.ok(r.candidates.length >= 3 && r.candidates.length <= 5, `${r.candidates.length} candidates`)
  assert.ok(!r.candidates.some((c) => c.text.includes('$5M')))
  for (const c of r.candidates) {
    assert.ok(c.text.length <= 70)
    assert.ok(inDraft(c.source, EMAIL))
  }
})

test('a draft under three sentences gets a notice, not candidates', async () => {
  assert.deepEqual(await runEdge({ slot: 'title', text: 'One sentence here. And another one.' }), { kind: 'empty', message: TOO_SHORT })
})

test('asking again leaves out what was shown; when nothing is left, it says so', async () => {
  const first = await runEdge({ slot: 'opening', text: EMAIL, kind: 'linkedin' })
  assert.equal(first.kind, 'edge')
  if (first.kind !== 'edge') return
  const again = await runEdge({ slot: 'opening', text: EMAIL, kind: 'linkedin', avoid: first.candidates.map((c) => c.text) })
  if (again.kind === 'edge') assert.ok(!again.candidates.some((c) => first.candidates.some((f) => f.text === c.text)))
  const all = fakeCandidates(EMAIL).map((c) => c.text.replace(/[.!]$/, ''))
  assert.deepEqual(await runEdge({ slot: 'opening', text: EMAIL, avoid: all }), { kind: 'empty', message: NOTHING_FITS })
})

test('an unknown slot falls back to a title', async () => {
  const r = await runEdge({ slot: 'nonsense' as never, text: EMAIL })
  assert.equal(r.kind, 'edge')
})
