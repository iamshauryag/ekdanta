// Scrollbars stay hidden until something scrolls, then fade out after a moment of rest, like macOS
// overlay scrollbars. Scroll events don't bubble, so one capturing listener sees every scroller.
// Browsers can't transition scrollbar styles, so the fade steps a --sb opacity (0–1) frame by frame.
const REST_MS = 1400
const FADE_MS = 500

export function autoHideScrollbars() {
  const timers = new WeakMap<Element, number>()
  const frames = new WeakMap<Element, number>()
  const set = (el: HTMLElement, v: number) => el.style.setProperty('--sb', v.toFixed(3))

  const fade = (el: HTMLElement) => {
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / FADE_MS)
      if (t >= 1) {
        el.style.removeProperty('--sb')
        frames.delete(el)
        return
      }
      set(el, 1 - t * t * (3 - 2 * t))
      frames.set(el, requestAnimationFrame(tick))
    }
    frames.set(el, requestAnimationFrame(tick))
  }

  document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target === document ? document.documentElement : (e.target as Element)
      if (!(el instanceof HTMLElement)) return
      cancelAnimationFrame(frames.get(el) ?? 0)
      set(el, 1)
      clearTimeout(timers.get(el))
      timers.set(
        el,
        window.setTimeout(() => fade(el), REST_MS),
      )
    },
    { capture: true, passive: true },
  )
}
