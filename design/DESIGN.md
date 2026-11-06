# Ekdanta — Design System

_Draft v0.1 · November 2026 · The visual reference behind the [brief](BRIEF.md), the [flows](FLOWS.md) and the [help ladder](HELP-LADDER.md)._

This document collects the tokens and component rules used across the mockups into one place, so the prototype and the app can be built from them directly. Where the mockups and this document disagree, this document wins.

## Principles in practice

- **Your words are the only full-strength text.** Prose is the darkest, largest text on screen. UI and AI output are always a step lighter or smaller.
- **As few lines as possible.** Separate things with space and tone before reaching for a border. A border earns its place only when it aids comprehension.
- **One accent.** Ink blue marks focus, selection, acceptance and links. There are no other brand colours.
- **Colour is never the only signal.** Deletions are also struck through, insertions are also underlined, and states are also written in words.

## Colour

Tokens are CSS custom properties. Contrast ratios are measured against `page` (and `chrome` where text sits on panels) using the WCAG formula. Every token used for text meets **4.5:1** on the surfaces it appears on.

### Surfaces and lines

| Token | Light | Dark | Use |
|---|---|---|---|
| `--page` | `#FAFAF9` | `#262523` | The writing surface and canvas |
| `--chrome` | `#F4F3F1` | `#1F1E1D` | Rail, left sidebar, right panel, title bar |
| `--chrome-2` | `#EFEEEB` | `#232221` | Instruction bar, inset fields |
| `--pop` | `#FFFFFF` | `#2F2D2B` | Floating surfaces: Recall card, Word list, toasts |
| `--line` | `#E5E3DF` | `#33312F` | Hairlines: title rule, panel edges, collapsed group rows |
| `--line-2` | `#D9D6D0` | `#42403C` | Slightly stronger hairlines: key caps, segmented controls |

### Text

| Token | Light | Ratio (page / chrome) | Dark | Ratio (page / chrome) | Use |
|---|---|---|---|---|---|
| `--ink` | `#1F1E1C` | 16.0 / 15.0 | `#E9E6E0` | 12.3 / 13.4 | The writer's text; primary UI text |
| `--ink-2` | `#5F5C56` | 6.4 / 6.0 | `#AEAAA2` | 6.6 / 7.2 | Secondary text: Nudges, excerpts, labels you read |
| `--ink-3` | `#6F6B64` | 5.1 / 4.8 | `#9A968E` | 5.2 / 5.7 | Tertiary text: metadata, hints, key legends, **ghost text**, AI labels |
| `--ink-4` | `#B9B5AD` | — | `#5C5953` | — | **Decorative only**: dots, separators, disabled glyphs. Never for text. |

> **Changed from the mockups.** The mockups used `#928E86` (light) and `#837F78` (dark) for tertiary text, which measure 3.1:1 and 3.8:1. Ghost text and AI labels now share `--ink-3`, which keeps them clearly lighter than the writer's ink (16:1) while staying readable.

### Accent

| Token | Light | Dark | Use |
|---|---|---|---|
| `--accent` | `#2F4F8F` (7.6:1) | `#8EA9E0` (6.5:1) | Focus, selection, accept, links, active tab |
| `--accent-soft` | `rgba(47,79,143,.12)` | `rgba(142,169,224,.16)` | Selection fill, chips, active states |
| `--accent-line` | `rgba(47,79,143,.35)` | `rgba(142,169,224,.45)` | Focus rings, connectors |
| `--on-accent` | `#FFFFFF` (8.0:1) | `#14161C` (7.7:1) | Text on a solid accent fill |
| `--scope` | accent at 7% | accent at 7% | The faint tint behind text a help request applies to |

### Diff

| Token | Light | Dark | Use |
|---|---|---|---|
| `--del-ink` | `#7F6559` (5.1:1) | `#B9998A` (5.8:1) | Deleted text, rejected labels, the one warm error glyph |
| `--del-bg` | `rgba(150,110,90,.10)` | `rgba(200,150,120,.12)` | Behind deleted text |
| insertion | `--ink` on `--accent-soft`, 1.5px `--accent` underline | same | Inserted text |

> **Changed from the mockups:** `--del-ink` was `#8A6F62` (4.4:1).

### Thinking Space

| Token | Light | Dark | Use |
|---|---|---|---|
| `--ai-line` | `rgba(95,92,86,.5)` | `rgba(174,170,162,.5)` | Dashed suggested links |
| `--region` | `rgba(31,30,28,.03)` | `rgba(255,255,255,.03)` | Cluster region fill |
| `--dot` | `rgba(31,30,28,.16)` | `rgba(255,255,255,.14)` | Canvas dot grid |

There is no red, green or yellow in the palette. Errors use one small `--del-ink` glyph and plain words.

## Typography

Two families, both open-licensed (SIL OFL) and loaded locally in the app:

- **[Newsreader](https://fonts.google.com/specimen/Newsreader)** for everything the writer writes: prose, titles, fragments, excerpts, word alternatives, Nudges.
- **[Inter](https://rsms.me/inter/)** for the interface: labels, metadata, buttons, hints.
- System monospace (`ui-monospace`) only for file paths.

| Style | Family | Size / line height | Weight | Use |
|---|---|---|---|---|
| Prose | Newsreader | 18.5px / 1.6 | 400 | The page |
| Title | Newsreader | 28px / 1.2 | 500, −0.015em | Document title |
| Fragment | Newsreader | 17.5px / 1.3 | 400 | Thinking Space canvas |
| Excerpt | Newsreader | 16px / 1.38 | 400 | Recall results, panel fragments |
| Nudge | Newsreader italic | 17px / 1.42 | 400 | Margin questions (`--ink-2`) |
| UI | Inter | 13px / 1.45 | 400–500 | Panel body, buttons |
| Meta | Inter | 12px | 400 | Meta line, captions, control rows |
| Level label | Inter caps | 10.5px, +0.06em | 600 | `⌘3 · WORD` (in `--accent`) |
| Section label | Inter caps | 10.5–11px, +0.06–0.1em | 600 | Panel headings, cluster labels (`--ink-3`) |
| Key cap | Inter | 10.5px | 500 | `<kbd>` |

- **Measure:** the page column is 640px (about 68 characters of prose).
- **Numbers:** Inter with tabular figures in counts and word totals.
- Your own renamed cluster labels switch from Inter caps to Newsreader italic, so your words always look like yours.

## Space, size and shape

- **Spacing scale (px):** 4 · 8 · 12 · 16 · 24 · 32 · 48. Paragraph spacing on the page is 0.95em.
- **Radii:** 4px key caps · 5px chips · 8px small cards, instruction bar · 12px floating cards and lists · 18px cluster regions · 50% dots and toggles.
- **Shadows:** one for floating surfaces only.
  - Light: `0 10px 30px rgba(40,35,25,.14), 0 1px 3px rgba(40,35,25,.10)`
  - Dark: `0 10px 30px rgba(0,0,0,.5), 0 1px 3px rgba(0,0,0,.4)`
- **Borders:** hairlines (`--line`) for structural edges only: the title rule, panel and rail edges, collapsed group rows. Cards, lists, fragments and cluster regions are borderless.

## Layout

```
┌──52──┬────────────────── page area ──────────────────┬─────300─────┐
│ rail │   84px ┊◀────────── 640px column ──────────▶┊   │ right panel │
│      │        ┊                                     ┊   │ (⌘\ hides;  │
│      │        ┊                                     ┊   │  page then  │
│      │        ┊                                     ┊   │  centres)   │
└──────┴─────────────────────────────────────────────────┴─────────────┘
 title bar 40px · status 28px (visible on hover only)
```

- **Rail:** 52px, icons 17px in 34px hit targets.
- **Right panel:** 300px. Module tabs in a 56px header.
- **Page:** a 640px column, left-aligned 84px from the rail when the panel is open; centred when the panel is collapsed or in Focus.
- **Margin:** at least 230px to the right of the column is reserved for Nudges when the panel is collapsed.
- **Minimum window:** 960 × 600. Below 1100px wide, the right panel overlays the page instead of docking.

## Components

### Help label
`⌘3 · WORD`: Inter caps, 10.5px, 600, `--accent`. Every suggestion carries one, top-left.

### Scope tint
`--scope` behind the text a request applies to, extended 12px left and right with box-shadow so it doesn't hug the glyphs. Shown while loading and while a suggestion is open.

### Recall card
`--pop`, radius 12, shadow, no border. Column-width, directly under the caret line, pushing the following text down. Results are Newsreader excerpts with a citation chip. The chosen result has an `--accent-soft` fill. The footer carries hints in `--ink-3`.

### Citation chip
`↳ Folder / Title, date` · Inter 11.5px, 500, `--accent` on `--accent-soft`, radius 5, padding 2×8. A ★ marks exemplars. Always a link to the source.

### Recall dot
7px circle, `--accent` at 30% opacity, in the left gutter level with the paragraph's first line. Hidden in Focus.

### Nudge
No container. Level label, then the question in Newsreader italic `--ink-2`, then actions in Inter 10.5px (`Resolve` in `--accent`). Sits in the right margin, top-aligned with its paragraph.

### Word list
`--pop`, radius 12, shadow, no border, 246px wide, left-aligned to the word. Options in Newsreader 17px. The chosen option is a solid `--accent` fill with `--on-accent` text, the one solid fill in the help UI, because choosing is the whole point of the list.

### Ghost text
Continuation text in `--ink-3`, same family and size as the prose, inline after the caret. A hint line follows the paragraph: level label plus `Tab accept · ⌥→ one word · ⌘4 next · Esc`.

### Instruction bar
`--chrome-2`, radius 9, no border. Level label, an inset `--page` field, and `↵ run` / `↵ refine · Esc`. Sits directly above the scoped text.

### Diff marks
- **Deleted:** `--del-ink` on `--del-bg`, 1px line-through.
- **Inserted:** `--ink` on `--accent-soft` with a 1.5px `--accent` underline.
- **Focused change:** a 1.5px `--accent-line` ring with 3px `--page` offset, and ✓ / ✕ buttons (19px circles in `--accent-soft` and `--del-bg`).
- **Accepted, still in view:** plain text with a dotted `--accent-line` underline, which fades after the diff closes.
- **Control row:** Inter 12px, `--ink-3`, items separated by `·` in `--ink-4`. `Accept all` in `--accent`, 600.

### Panel module tabs
Three 34 × 28 icon buttons with their shortcut beneath (`⌘⌥1`, 9.5px, `--ink-4`). The active tab gets `--accent-soft` and `--accent`. The collapse control sits at the far right.

### History item
`--page` card on `--chrome`, radius 9, no border. A `¶N` tag, the level and time, then the content and outcome. Hover adds a 1.5px `--accent-line` ring and tints the paragraph on the page.

### Fragment
Newsreader 17.5px on the canvas, no border or fill. The fragment being typed shows only the caret. In the panel: Newsreader 16px with a 14px status circle (hollow when unused; filled `--line` with a check when used, text in `--ink-3`).

### Suggested link
1.2px `--ai-line`, dashed 4/4, round caps, 2px dots at each end, gently curved. Label in Inter 10.5px `--ink-3`, haloed with a 6px `--page` stroke so it stays readable over the grid.

### Cluster region
`--region` fill, radius 18, no outline. Label top-left in Inter caps, `--ink-3`, with a dotted `--ai-line` underline (suggested) or in Newsreader italic `--ink` (renamed by you).

### State line
One line in Inter 12.5px `--ink-2` where the suggestion would have appeared: level label, message, then at most two actions in `--accent`. Never a modal.

### Key cap
`<kbd>`: Inter 10.5px, 500, `--ink-2` on `--chrome`, 1px `--line-2` border with a 2px bottom, radius 4.

## Motion

| What | Duration | Easing |
|---|---|---|
| Suggestion in | 150ms | ease-out, opacity only |
| Suggestion out | 100ms | ease-in, opacity only |
| Text making room for a card | 150ms | ease-out |
| Focus mode in/out, panel collapse | 150ms | ease-in-out |
| Thinking Space ↔ editor | 200ms | ease-in-out, crossfade |

Nothing slides, scales or bounces. With **reduced motion** enabled, every transition is instant.

## Icons

Line icons at 17px on a 20px grid, 1.5px stroke, round caps and joins, `currentColor`. A consistent set such as [Lucide](https://lucide.dev) (ISC license) is the reference. No sparkle, wand or robot icons anywhere: the AI has no icon of its own.

## Theming

Light and dark are equal citizens. The app follows the system setting by default, with an override in Settings. Both themes use the same tokens with different values, so every component works in both without special cases.

## Open questions

- **Prose size:** should 18.5px be adjustable from Settings (for example 16–22px), with the measure staying at about 68 characters?
- **Second accent:** is one accent enough once there are several kinds of AI output, or should Recall (your own material) get a distinct, quieter tone from generated help?
