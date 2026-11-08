// When a note last changed, read from its file (its mtime) rather than stored in front matter: no
// file is rewritten just to stamp a date, and Obsidian reads the same date (file.mtime) its own way.

/** "Today, 14:32", "Yesterday, 09:05", "3 Nov, 18:00", or "3 Nov 2025, 18:00" for another year. Local time. */
export function modifiedLabel(ms: number, now = new Date()): string {
  const at = new Date(ms)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  // Whole days between the two dates, counted by calendar day so a clock change doesn't skew it.
  const days = Math.round((day(now) - day(at)) / 86_400_000)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  const month = MONTHS[at.getMonth()]
  return at.getFullYear() === now.getFullYear() ? `${at.getDate()} ${month}, ${time}` : `${at.getDate()} ${month} ${at.getFullYear()}, ${time}`
}

/** The same moment as a date, for a tooltip or a search: 2026-11-08 14:32. */
export function modifiedStamp(ms: number): string {
  const at = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
