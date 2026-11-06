# Ekdanta — Design Brief

_Draft v0.3 · November 2026 · See also the [product spec](../docs/SPEC.md)._

Ekdanta is a "Cursor for writers": a local-first app that holds all of your writing and knowledge, learns your voice per platform, and helps **only when asked, only as much as asked**. This brief sets the principles, the feel, and the visual direction that the flows, help-ladder spec, design system and prototype will follow.

## Decisions so far

| Question | Decision |
|---|---|
| Thinking Space vs editor | **Own full-screen mode.** You brain-dump on a full canvas; when you start drafting it collapses into a side panel beside the editor. |
| Overall feel | **Quiet modern.** Neutral, calm, typographic; closer to iA Writer and Linear than to a notebook or a manuscript. |
| Where help appears | **Take Cursor's lessons:** help comes to where your attention already is, one keystroke away, with clear accept/reject. See "Lessons from Cursor" below. |
| Prototype goal | **Feel-first.** The prototype exists to try the interactions with real typing, not to demo finished visuals. |
| Visual direction (after mockups) | **A · Studio as the everyday mode**, plus a separate **Focus mode** (from B): one keystroke hides everything except your text, with nothing left but the page and the caret. |
| Autocomplete | **Never unsolicited.** No ghost text, completions or suggestions appear while you type. Every suggestion, including Cmd+4 continuation, appears only after an explicit keystroke and disappears as soon as you type. |
| Right section | **A modular panel.** It holds a small set of modules you switch between; see "The right panel" below. |
| Recall margin dot | **Kept on.** A faint dot beside a paragraph when Recall has something relevant. It is a hint, not a suggestion: it shows no content until you press Cmd+1 or click it. It can be turned off in Settings. |

## The right panel

**Purpose:** everything *about* the piece that isn't the piece itself. Your words stay on the page; your material, your requested help and the piece's facts live in the panel.

**Rules**
- **One module visible at a time**, chosen from a short icon row at the top of the panel (or with ⌘⌥1–3). Ekdanta remembers the last module per document.
- **Collapsible** with ⌘\\. When collapsed, the page re-centres. **Focus mode hides it completely.**
- **Nothing appears unrequested.** Modules only show what you put there (fragments, pins) or asked for (Nudges, Recall), plus plain facts about the document. The one exception is the Recall dot, which lives in the page margin, not the panel.
- **Anchored, not a feed.** Items tied to a paragraph line up beside it, like comments in Word. Hovering an item highlights its paragraph.

**v1 modules**

| Module | Shows | Empty state |
|---|---|---|
| **Material** | This piece's Thinking Space fragments, with used ones ticked and unused ones visible, plus sources you've pinned (notes, highlights, past writing). Drag a fragment into the page to quote it. | "No thinking yet. ⌘T opens the Thinking Space." |
| **History** | A history of help you summoned in this document: Nudges, Recall results and diffs (accepted, rejected, edited after accepting), each anchored to its paragraph. You can resolve or clear items. | Hidden from the icon row until you've asked for help once. |
| **Piece** | Facts about the document: platform, word count against the platform's typical length, active voice profile, help ceiling, and an outline built from headings and paragraph first lines. No AI content. | Always has content. |

**Material shows one group at a time.** Fragments are listed under their cluster labels. Only the group that matches the paragraph being written is open (marked "this paragraph"); every other group folds to one line with a count, such as "The body 0/3". Opening a group is one click. Following the caret only changes which of your own groups is open; it never adds content.

Later candidates, not in v1: Sources from the web (labelled external), Agent tasks, Linter checks.

## Thinking Space

- **Borderless fragments.** Fragments are plain text on a faint dot grid, with no boxes or borders. The fragment being typed shows only the caret.
- **Your words versus the AI's.** Fragments are always in the prose serif at full strength. Everything the AI adds (dashed links, tiny link labels, cluster labels in small grey capitals, Recall chips) is visibly secondary. A cluster label you rename switches to your serif italic.
- **Clusters are soft regions:** a faint tinted area with a label, no outline. Fragments that fit no cluster sit under a plain "unclustered" label.

## Design principles

1. **The page belongs to the writer.** Your words are the only full-strength text on screen. Everything the AI offers is visibly secondary (lighter, smaller, or ghosted) until you accept it.
2. **Silence is the default.** No suggestions or autocomplete while typing, ever, unless you ask. No badges, no counters asking for attention. The only passive signal is a faint margin dot when Recall has something relevant (on by default, can be turned off).
3. **Help is a ladder, not a chat.** Five levels, five keys. The interface always makes clear which level you're on, so you never get more help than you asked for.
4. **Nothing changes without a diff.** Any change to your words appears as a word-level diff that you accept or reject. The code computes the diff, never the model.
5. **Show the source.** Anything drawn from your knowledge carries a citation chip back to the note, highlight or past piece.
6. **Your files, plainly.** Markdown, front-matter and JSON Canvas on disk. The UI never hides where something lives.
7. **Calm over clever.** Few colours, little motion, no sparkle icons, no "✨ AI" branding. The AI is a quiet colleague, not a feature to show off.

## Lessons from Cursor (for the help ladder)

What makes Cursor feel intuitive, and how it carries over:

| Cursor does | Why it works | Ekdanta equivalent |
|---|---|---|
| **Tab ghost text**: grey continuation at the cursor; Tab accepts, keep typing to ignore | Zero UI, zero mode switch; ignoring costs nothing | We keep the presentation, not the trigger: Cursor offers ghost text unprompted, and Ekdanta **never** does. Only after you press **Cmd+4** does a continuation appear as ghost text. Tab accepts, Esc or typing dismisses, Cmd+4 again cycles. |
| **Cmd+K inline bar** at the selection; type an instruction; the result appears as an inline red/green diff with Accept/Reject | Help stays at the point of focus; instruction and result in one place | **Cmd+5 Passage**: a small instruction bar opens at the selection, then an inline word-level diff. Cmd+Enter accepts all, Cmd+Backspace rejects all, or accept/reject per change. Also used for Cmd+4 rewrites of a selected sentence. |
| **Autocomplete-style lists** at the cursor, navigated with the keyboard | Familiar; choosing is faster than reading | **Cmd+3 Word**: 3–5 options in a compact list under the cursor: replacements for a selected word, or the next word when nothing is selected. Arrows and Enter pick, Esc closes. |
| **Side chat (Cmd+L)** for longer, exploratory requests | Keeps long output off the page | **Recall** results that go beyond one item, and later Agent tasks, open in a right panel. The page itself never fills with chat. |
| **Same keys everywhere, minimal chrome** | Muscle memory beats menus | Every level works the same way in every document. No toolbar is needed to reach help. |

How the two lighter levels fit this pattern:
- **Cmd+1 Recall**: a slim card anchored under the current line with the top 1–2 sources (quote and citation chip). "More" opens the right panel. It writes nothing; you can insert a quote explicitly.
- **Cmd+2 Nudge**: a single line of italic grey text in the margin beside the paragraph, phrased as a question. It is never inserted into the text.

The full detail (states, dismissal, cycling, empty and error states) is in [`HELP-LADDER.md`](HELP-LADDER.md).

## The feel

**Quiet modern.** Calm, literary in its typography but modern in its UI. The test: open the app and the first thing you notice is your own sentence, not the tool.

- **Words used:** calm, precise, spacious, typographic, trustworthy.
- **Avoid:** dashboard density, gradients, purple-AI aesthetics, chat-bubble UIs, gamification (streaks, scores), skeuomorphic paper.
- **Prose first:** a generous measure (about 65–72 characters), comfortable line height (about 1.6), a quality text face. UI chrome uses a smaller sans and recedes.
- **Motion:** short fades (120–180 ms) for suggestions appearing and leaving. Nothing bounces.

## Visual directions

All three directions are "quiet modern". They differ in the writing face, how much of the IDE structure stays visible, and the accent.

### A · Studio (recommended)
- **Layout:** a collapsible file tree on the left, a centred page, a right panel only on demand. Chrome fades out while you type and returns when you move the mouse.
- **Type:** serif for prose (Newsreader or Source Serif 4, both open-licensed), Inter for the UI.
- **Colour:** near-white `#FAFAF9` page, warm greys, one ink-blue accent for focus, selection and accept. Dark theme in soft charcoal.
- **Why:** reads like good editorial typography while keeping Cursor-like structure (tree, panels, shortcuts). It suits essays as well as LinkedIn posts and emails.

### B · Typewriter Calm
- **Layout:** focus-mode first. A single column; the file tree and panels open as overlays. Current-sentence highlighting is optional.
- **Type:** a duospace or mono writing face (iA Writer Quattro or IBM Plex Mono, both open-licensed), the same family for the UI.
- **Colour:** off-white or graphite with a single warm accent (amber caret).
- **Why:** the most distraction-free; great for drafting and for slow perfectionists. A mono face makes long-form reading slightly heavier and is less "finished".

### C · Writer's IDE
- **Layout:** openly Cursor-like. Persistent file tree, tabs, a status bar showing platform, voice profile and help ceiling, and a docked right panel.
- **Type:** sans for both prose and UI (Inter, or Inter Display for headings).
- **Colour:** dark-first neutral greys with a cool accent.
- **Why:** instantly familiar to Cursor users and shows the system's state (voice, ceiling, sources). The risk is that it feels like a tool for code rather than a place to write.

### Recommendation
**A · Studio**, borrowing two things from the others: B's **focus mode** (chrome hidden while typing) and C's **quiet status bar** (platform · voice profile · help ceiling), shown only on hover. That combination gives you calm when writing and structure when managing the vault.

## Mockups

Static HTML mockups of the main editor, each with a light/dark toggle. Open them in a browser.

- [`mockups/direction-a.html`](mockups/direction-a.html): Direction A, two layouts (centred page; left page with a margin column).
- [`mockups/direction-b.html`](mockups/direction-b.html): Direction B, two layouts (pure focus page; vault overlay with Recall).
- [`mockups/direction-a3.html`](mockups/direction-a3.html): **the chosen direction.** Studio with the modular right panel (Material, History, Piece) and Focus mode.
- [`mockups/thinking-space.html`](mockups/thinking-space.html): the Thinking Space (loose map, clusters, and the hand-off into drafting).
- [`mockups/help-levels.html`](mockups/help-levels.html): each help level, ⌘1 to ⌘5, in the editor.
- [`mockups/help-review.html`](mockups/help-review.html): reviewing a diff (inline and side by side) and every help state.

## Out of scope for design v1
Collaboration, accounts or billing, grammar-checker UX, AI-detection evasion, full-page generation, mobile.
