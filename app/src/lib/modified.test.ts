import test from 'node:test'
import assert from 'node:assert/strict'
import { modifiedLabel, modifiedStamp } from './modified.ts'

test('when a note last changed reads as today, yesterday, a date, or a date in another year', () => {
  const now = new Date(2026, 10, 8, 15, 0)
  assert.equal(modifiedLabel(new Date(2026, 10, 8, 9, 5).getTime(), now), 'Today, 09:05')
  assert.equal(modifiedLabel(new Date(2026, 10, 7, 23, 59).getTime(), now), 'Yesterday, 23:59')
  assert.equal(modifiedLabel(new Date(2026, 10, 3, 18, 0).getTime(), now), '3 Nov, 18:00')
  assert.equal(modifiedLabel(new Date(2025, 11, 31, 8, 0).getTime(), now), '31 Dec 2025, 08:00')
  // Across a month end, yesterday is still yesterday.
  assert.equal(modifiedLabel(new Date(2026, 9, 31, 20, 0).getTime(), new Date(2026, 10, 1, 7, 0)), 'Yesterday, 20:00')
  assert.equal(modifiedStamp(new Date(2026, 0, 2, 3, 4).getTime()), '2026-01-02 03:04')
})
