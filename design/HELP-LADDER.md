# Ekdanta — The Help Ladder

_Draft v0.1 · November 2026 · Builds on the [design brief](BRIEF.md) and the [flows](FLOWS.md). Mockups: [the five levels](mockups/help-levels.html) and [diff review and states](mockups/help-review.html)._

This is the interaction spec for Ekdanta's five help levels: exactly how each one is asked for, how it appears, how you act on it, and how it leaves. It is written to be implemented from.

## Rules that apply to every level

1. **Only on request.** Nothing is generated while you type. Each suggestion is the result of one explicit keystroke (or click). The single passive signal in the whole app is the Recall dot, which shows no content by itself.
2. **One suggestion on screen at a time.** Asking for another level replaces the current suggestion. There is never a stack of cards.
3. **Typing wins.** Any keystroke that edits the document, other than the keys listed for that suggestion, dismisses it instantly. The keystroke still goes into the document; no input is ever swallowed. The one exception is a Nudge: it sits in the margin, covers nothing, and stays while you write your answer, until you resolve it, dismiss it, or move to another paragraph.
4. **Your text is never changed without a diff.** Levels 1–3 never touch your text unless you explicitly insert or pick something. Levels 4–5 always present changes as a diff.
5. **The level is always labelled.** Every suggestion carries a small label naming its level and key, for example `⌘3 · Word`.
6. **Same key again = next.** Pressing the level's key while its suggestion is showing cycles to the next suggestion. After the last one, the label shows "No more · ⌘3 to start again".
7. **Esc or ⌘0 dismisses.** Dismissing is silent and always available.
8. **Never cover the writer's text.** Cards and lists that open under a line (Recall, Word, the Passage bar) push the following text down rather than floating over it, and the page settles back when they close. Only the margin and the right panel hold help beside the text.
9. **Everything is recorded.** Each request and its outcome (accepted, rejected, dismissed, edited after accepting) is added to the Help module, anchored to its paragraph.

### Scope: what the help applies to

| If you have… | ⌘1 Recall | ⌘2 Nudge | ⌘3 Word | ⌘4 Sentence | ⌘5 Passage |
|---|---|---|---|---|---|
| **No selection** | Current paragraph | Current paragraph | Word at the caret | Continue from the caret | Current paragraph |
| **A word or phrase selected** | The selection | The selection | The selection | Rewrite the sentence containing it | The selection |
| **A sentence or more selected** | The selection | The selection | Not available (one-line notice) | Rewrite the selection if it is one sentence; otherwise acts as ⌘5 | The selection |

The scope is briefly outlined on the page (a faint tint behind the affected text) while the suggestion is loading and showing, so you always know what the help is about.

### The ceiling

You set a help ceiling (0–5) in Settings or in the Piece module. Asking for a level above it never silently does something else:

- A one-line notice appears where the suggestion would have been: `Ceiling is 3 · press ⌘4 again to allow once`.
- Pressing the key again within three seconds runs that level once. The ceiling itself doesn't change.
- With the ceiling at 0, every key shows `Help is off · change in Piece (⌘⌥3)`.

## Level by level

### ⌘1 · Recall — your own material

**Purpose:** bring back what *you* have written, kept or highlighted that relates to this point. Recall never generates text.

**Appearance.** A slim card anchored just below the current line, as wide as the text column and at most three results tall.

```
  …how you get past it, to the second and third idea.|
  ┌───────────────────────────────────────────────────────────┐
  │ ⌘1 · RECALL                              2 of your sources │
  │ "Patience is not a mood. It is a way of refusing the       │
  │  first version of a sentence."                             │
  │  ↳ Notes / On Craft, Mar 2025                              │
  │ "I left the last paragraph undone for a week…"             │
  │  ↳ Essays / The Unfinished Room ★                          │
  │ ⌘↵ insert quote · ↑↓ choose · Esc          More  ⌘⇧1       │
  └───────────────────────────────────────────────────────────┘
```

- **Results** are passages from your vault: notes, highlights, past writing and this document's Thinking Space fragments, in that order of priority. Each shows a short excerpt and a **citation chip** (folder / title, plus date or ★ where relevant).
- **Keys:** <kbd>↑</kbd><kbd>↓</kbd> choose a result; <kbd>⌘↵</kbd> inserts the chosen excerpt at the caret as a quotation with its citation link; <kbd>↵</kbd> on a chip opens the source in a split view; <kbd>⌘1</kbd> again shows the next three; <kbd>⌘⇧1</kbd> ("More") moves all results into the Help module, where there's room to read them.
- **Relevance floor.** Only results above a similarity threshold are shown. Recall would rather show one strong result than three weak ones.

**The Recall dot.** When Recall has at least one strong result for a paragraph, a 7px dot at 30% opacity appears in the left gutter beside it. It is computed in the background on paragraph change, never on every keystroke. Clicking the dot is the same as pressing ⌘1 there. The dot can be turned off in Settings and is hidden in Focus mode.

### ⌘2 · Nudge — one question

**Purpose:** unstick you without putting words in your mouth.

**Appearance.** A single line of italic serif text in the page's right margin, level with the paragraph, in the secondary ink colour. If the right panel is open, the Nudge appears at the top of the Help module instead, anchored to the paragraph.

```
  Speed gives you the first idea that arrives,      ⌘2 · NUDGE
  and the first idea is rarely yours…               What did you rush to,
                                                    that winter?
```

- **Content rule:** one question or one direction, at most 20 words. Never a sentence you could paste into the draft. Nudges are checked in code before display: anything that looks like draft prose (several sentences, or no question or imperative) is discarded and regenerated once, then the level reports "No useful nudge here" rather than break the rule.
- **Keys:** <kbd>⌘2</kbd> again for a different question; <kbd>Esc</kbd> to dismiss; **Resolve** (click, or <kbd>⌘↵</kbd>) marks it answered in the Help module.
- A Nudge **is never inserted** into the document. There is no "accept".

**Typical nudges:** "What's the counter-argument?", "Which example would a reader remember?", "You noted 'kept drafts vs deleted drafts' but haven't used it. Still relevant?"

### ⌘3 · Word — a few alternatives

**Purpose:** the word is almost right.

**Appearance.** A compact list directly below the word, aligned to its left edge, in the prose serif.

```
  …where the strange| and particular things live.
             ┌──────────────────────────────┐
             │ ⌘3 · WORD  replace "strange" │
             │ ▸ peculiar                 ↵ │
             │   uncommon                 2 │
             │   singular                 3 │
             │   unfamiliar               4 │
             │ ↑↓ choose · ↵ pick · Esc     │
             └──────────────────────────────┘
```

- **Content:** 3–5 alternatives that fit the sentence's grammar and the platform's register, best first. They come from a small, fast model and are re-ranked using your own vocabulary (words you use often rank higher; words you've rejected before rank lower).
- **Keys:** <kbd>↑</kbd><kbd>↓</kbd> or <kbd>2</kbd>–<kbd>5</kbd> to choose; <kbd>↵</kbd> or <kbd>Tab</kbd> replaces the word; <kbd>⌘3</kbd> again for a fresh set; <kbd>Esc</kbd> keeps the original.
- **Replacing a word is a one-word change and is applied directly** (no diff), with a brief highlight on the new word. <kbd>⌘Z</kbd> restores the original.

### ⌘4 · Sentence — continue or rewrite one sentence

**Purpose:** you know where the sentence is going but not how to get there.

**Continue (no selection).** Grey **ghost text** appears after the caret, completing the current sentence, or offering the next one if the caret is at a sentence end. It is at most one sentence.

```
  …a reader can feel the difference between a sentence that was |chosen
  and a sentence that merely arrived.
  Tab accept · ⌘4 next · Esc
```

- **Keys:** <kbd>Tab</kbd> accepts the whole continuation; <kbd>⌥→</kbd> accepts one word at a time; <kbd>⌘4</kbd> again shows the next continuation; <kbd>Esc</kbd> or any typing dismisses it.
- Ghost text **streams in** as it is generated, because it doesn't change any existing text.

**Rewrite (a word or sentence selected).** The sentence is shown as an **inline diff** in place (see "The diff" below), with the same controls as Passage.

### ⌘5 · Passage — rewrite on instruction

**Purpose:** a passage needs reworking, and you can say how.

1. **Instruction bar.** Pressing <kbd>⌘5</kbd> opens a slim bar just above the selection (or the current paragraph), with the label `⌘5 · Passage` and a text field: "How should this change?". Recent instructions appear as you type (<kbd>↑</kbd> to recall the last one).
2. **Run.** <kbd>↵</kbd> sends the instruction. The scope tint stays; a thin progress line runs along the bar's bottom edge. The original text stays fully readable and editable meanwhile; editing it cancels the request.
3. **Result.** The passage is replaced in place by an inline diff, with the control row beneath it (see "The diff").
4. **Refine.** The bar stays open above the diff. A new instruction produces a new diff **against the original text**, never against the previous suggestion.

The model is given the instruction, the passage, the surrounding paragraphs, the platform, the voice profile and a few samples of your own similar writing. It is never given permission to touch text outside the scope; anything it returns outside the scope is discarded.

## The diff

Used by ⌘4 (rewrite) and ⌘5, and by voice-profile rebuilds.

```
  Slow writing is really about attention, about the value of patience in the
                                         ─────────────────────────────────────
  creative process.: staying with one sentence until it sounds like me.
  ──────────────── ═══════════════════════════════════════════════════
  ⌘↵ Accept all · ⌘⌫ Reject all · 2 changes · Tab to step through
```

- **Computed by code, word by word**, from the original text and the model's output. The model never decides what counts as a change.
- **Deletions:** struck through, warm tint, secondary ink. **Insertions:** accent underline with a faint accent wash, full ink. Unchanged words are untouched.
- **Accept all** <kbd>⌘↵</kbd> · **Reject all** <kbd>⌘⌫</kbd>.
- **Per change:** <kbd>Tab</kbd> / <kbd>⇧Tab</kbd> move between changes; on the focused change, <kbd>↵</kbd> accepts it and <kbd>⌫</kbd> rejects it. Hovering a change shows its own ✓ and ✕. When every change has been decided, the diff closes by itself.
- **After accepting**, the text is ordinary text. <kbd>⌘Z</kbd> restores the original in one step. Edits you make to accepted text within the next minute are recorded as "edited after accept", the most valuable signal of your taste.
- **Large diffs.** If more than about 60% of the words change, the diff switches to a side-by-side view (original left, suggestion right), because an inline diff that dense is unreadable. Accept and reject work the same way.

## States

Every level uses the same small set of states, shown in the place where its suggestion would appear.

| State | What you see | Notes |
|---|---|---|
| **Loading** | The level label and a thin progress line. For ⌘3 and ⌘1 the card appears at its final size, empty, to avoid layout jumps. | After 8 seconds: "Still working · Esc to cancel". |
| **Nothing useful** | One quiet line: Recall "Nothing in your vault on this yet"; Nudge "No useful nudge here"; Word "No better word found". | Never padded with weak results. |
| **No model configured** | "Connect a model in Settings (⌘,) to use ⌘2–⌘5." | Recall still works offline on local embeddings. |
| **Offline / provider error** | "Couldn't reach Anthropic · Retry (⌘R) · Use Ollama". | One line, one or two actions, no stack traces. |
| **Key rejected** | "Your API key was rejected · Open Settings". | |
| **Above ceiling** | "Ceiling is 3 · press ⌘4 again to allow once". | See "The ceiling". |
| **Not available here** | For example "⌘3 works on a word or short phrase". | For scope mismatches. |

Errors never appear as modal dialogs and never interrupt typing.

## Timing and motion

- **Latency targets:** Recall under 300 ms (local); Word under 800 ms; Nudge and Sentence under 2 s; Passage under 6 s.
- **Fades:** suggestions fade in over 150 ms and out over 100 ms. Nothing slides or bounces.
- **Debounce:** the Recall dot recomputes at most once per paragraph change, after 1.5 s without typing.
- **Cancel:** <kbd>Esc</kbd> during loading cancels the request (and the provider call, where the API allows).

## The Help module record

Every request is written to the document's help history (`.ekdanta/history/<document>.jsonl`) and shown in the Help module:

| Field | Example |
|---|---|
| Level and time | `⌘5 · Passage · 10:14` |
| Paragraph anchor | `¶3` (re-anchored if the paragraph moves) |
| Instruction | "make this less abstract" (⌘5 only) |
| Outcome | accepted / rejected / partly accepted (2 of 3) / dismissed / edited after accept |
| Sources | citation chips (⌘1, and ⌘4–⌘5 when your own writing was used as samples) |

Items can be resolved or cleared individually. The history is local only and is never sent anywhere except as examples in your own future prompts.

## Focus mode

All five levels work in Focus mode and look the same, except:

- The Recall dot is hidden.
- Nudges appear in the margin even though the panel is hidden.
- "More" (⌘⇧1) leaves Focus mode and opens the Help module.

## Accessibility

- Every suggestion is announced to screen readers through a polite live region: the level, then the content ("Word: 4 alternatives, peculiar selected").
- All actions are reachable from the keyboard, and every keyboard action has a visible, clickable equivalent.
- Diff colours are never the only signal: deletions are also struck through and insertions are also underlined.
- With reduced motion turned on, fades become instant.
- Ghost text and all secondary text meet a 4.5:1 contrast ratio against the page in both themes. The final values are in [`DESIGN.md`](DESIGN.md).

## Open questions

- **Recall insert format:** should an inserted quote be a Markdown blockquote with a wikilink, or an inline quotation with a footnote-style link?
- **Continuation length:** is one sentence right for ⌘4, or should repeated ⌘4 extend the same continuation rather than replace it?
- **Diff threshold:** is ~60% changed the right point to switch to side-by-side?
