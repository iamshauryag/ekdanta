# Ekdanta — Information Architecture and Flows

_Draft v0.1 · November 2026 · Builds on the [design brief](BRIEF.md) and the [product spec](../docs/SPEC.md)._

This document defines the screens, how you move between them, and the step-by-step flows for the core jobs. How each help level looks and behaves in detail is covered separately in `HELP-LADDER.md`.

## Screens

Ekdanta has one main window and a small number of modes inside it. There are no dashboards, home feeds or onboarding carousels.

| Screen | What it is | Opened with |
|---|---|---|
| **Editor** | The main surface: the page, the icon rail on the left, the modular right panel. | Opening any document |
| **Focus** | The editor with everything hidden except the page and the caret. | <kbd>⌘.</kbd> (Esc or <kbd>⌘.</kbd> to leave) |
| **Thinking Space** | A full-screen canvas of loose fragments for one document, before or alongside drafting. | <kbd>⌘T</kbd>, or "Open Thinking Space" in the Material module |
| **Vault** | The file tree in the left sidebar: folders, documents, ★ exemplars. | The folder icon in the rail, or <kbd>⌘⇧E</kbd> |
| **Quick open** | Fuzzy search over every file and heading in the vault. | <kbd>⌘P</kbd> |
| **Search** | Full-text and semantic search across the vault, with results grouped by folder. | <kbd>⌘⇧F</kbd> |
| **Voice** | The readable, editable voice profile for each platform, and the exemplars it's built from. | Rail icon, or "view" next to Voice profile in the Piece module |
| **Settings** | AI provider and keys, help ceiling, shortcuts, Recall dot, import sources. | <kbd>⌘,</kbd> |
| **First run** | A three-step setup shown once: choose a vault, connect a model, import (optional). | First launch |

### The editor at a glance

```
┌────┬─────────────────────────────────────────────┬──────────────────────┐
│rail│  Essay · draft · essays/why-slow.md         │ [Material|Help|Piece]│
│    │  Why Slow Writing Matters                   │                      │
│ ▢  │  ─────────────────────────────              │  module content      │
│ ⌕  │  Your text, at full strength.               │  (only what you put  │
│ ★  │                                             │   there or asked for)│
│ ◎  │ • ← Recall dot (the only passive signal)    │                      │
│    │                                             │                      │
│ ⚙  │                                             │                      │
└────┴─────────────────────────────────────────────┴──────────────────────┘
  status (on hover): Platform · Voice profile · Ceiling · word count
```

- **Rail (left):** Vault, Search, Exemplars (★), Voice, Settings. Each opens in the left sidebar, so the page never moves sideways.
- **Right panel:** one module at a time (Material <kbd>⌘⌥1</kbd>, Help <kbd>⌘⌥2</kbd>, Piece <kbd>⌘⌥3</kbd>). <kbd>⌘\\</kbd> collapses it, and the page re-centres.
- **Status:** platform, voice profile, help ceiling and word count, shown only on hover at the bottom edge.

### Global shortcuts

| Keys | Action |
|---|---|
| <kbd>⌘1</kbd>–<kbd>⌘5</kbd> | Help levels: Recall, Nudge, Word, Sentence, Passage |
| <kbd>Esc</kbd> / <kbd>⌘0</kbd> | Dismiss the current suggestion |
| <kbd>⌘T</kbd> | Thinking Space for this document |
| <kbd>⌘.</kbd> | Focus mode |
| <kbd>⌘\\</kbd> | Collapse or expand the right panel |
| <kbd>⌘⌥1</kbd>–<kbd>⌘⌥3</kbd> | Right panel module: Material, Help, Piece |
| <kbd>⌘P</kbd> / <kbd>⌘⇧F</kbd> | Quick open / search |
| <kbd>⌘N</kbd> | New document |
| <kbd>⌘,</kbd> | Settings |

All shortcuts are remappable. In the browser build, the help levels move to <kbd>⌥1</kbd>–<kbd>⌥5</kbd> because browsers reserve <kbd>⌘1</kbd>–<kbd>⌘9</kbd> for tabs.

## Files on disk

Every screen maps to plain files, so the vault stays readable in any editor and in Obsidian.

```
my-vault/
├── essays/
│   ├── why-slow-writing-matters.md        ← the draft (front-matter: platform, status, ★, source, dates)
│   └── why-slow-writing-matters.canvas    ← its Thinking Space (JSON Canvas)
├── linkedin/ · emails/ · notes/ · highlights/
└── .ekdanta/
    ├── voice/essay.md                     ← readable, editable voice profile per platform
    ├── history/why-slow-writing-matters.jsonl   ← help history (requests, accepts, rejects)
    └── index/                             ← search index; safe to delete, always rebuilt
```

---

## Flows

### 1. First run and import

**Goal:** from a fresh install to writing in your own vault, in under two minutes. Import is optional and can run in the background.

1. **Welcome.** One screen: "Ekdanta works on a folder of Markdown files you own." Two buttons: **Open an existing folder** (for example an Obsidian vault) and **Create a new vault**.
2. **Model.** Choose a provider: Anthropic, OpenAI or Google (paste a key, stored in the system keychain), or Ollama (detected automatically if running). A **Skip for now** link leaves every help level disabled except Recall, which works offline on local embeddings.
3. **Import (optional).** Pick sources: Google Docs (via a Google Takeout or Drive export), Word files, Google Keep, or "a folder of Markdown". Each shows what it expects, for example "Drop your Takeout .zip here".
4. **Import runs in the background.** You land in the editor straight away, on a blank document or the vault's most recent file. A quiet progress line in the status area reads "Importing 214 documents… 38%".
5. **Review platforms.** When the import finishes, a single review sheet lists the imported documents with a guessed platform (Essay, LinkedIn, Email, Text, Blog, Note) and original dates. You can correct the guesses in bulk, or click **Looks right**.
6. **Suggest exemplars.** The same sheet ends with "Mark a few pieces that sound most like you", which leads into flow 2. It can be skipped.

**Edge cases:** an import that fails partway reports which files failed and why, and keeps the rest. Re-importing the same source skips files that are already in the vault.

### 2. Marking exemplars (★)

**Goal:** tell Ekdanta which pieces represent your voice at its best, per platform. This is the strongest signal for the voice profile.

1. In the Vault sidebar, hover a document and click ☆, or press <kbd>⌘⇧8</kbd> with the document open. The star fills, and the file's front-matter gains `exemplar: true`.
2. The first time, a small popover asks **"Exemplar for which platform?"**, pre-filled with the document's own platform. A document can count for several platforms.
3. The **Exemplars** view in the rail lists all ★ pieces grouped by platform, with a count per platform and a hint when a platform has fewer than three ("Add 2 more LinkedIn posts for a reliable profile").
4. After any change to the exemplars, the affected voice profile is marked **"Out of date · Rebuild"**. Rebuilding never happens silently (see flow 7).

### 3. Brain-dump in the Thinking Space, then drafting

**Goal:** get what's in your head out quickly, see how it connects, and carry it into the draft without losing anything.

1. **Open.** <kbd>⌘N</kbd> creates a document; choose its platform (flow 6). Press <kbd>⌘T</kbd> to open its Thinking Space: an empty full-screen canvas with a caret and the hint "Type anything. Return starts a new fragment."
2. **Dump.** Type fragments in plain or broken words. Return starts a new fragment near the last one. Click anywhere to place a fragment there. Paste links or quotes as fragments. Hold the mic button (or <kbd>⌥Space</kbd>) to dictate; speech-to-text runs locally.
3. **Links appear quietly.** After a pause of a few seconds, Ekdanta draws soft, dashed links between related fragments with tiny labels ("same idea", "contradicts", "example of"), and adds Recall chips where a fragment matches your notes. Links never move fragments. Hold <kbd>⌥</kbd> to hide all links. Delete a link to tell Ekdanta it was wrong.
4. **Clusters (optional).** Switch the view to **Clusters** to see fragments gathered into groups with one- or two-word labels. Labels are editable. Moving a fragment between groups is allowed and is remembered.
5. **Possible order (optional, on request).** **Possible order** proposes an arc through the clusters, as a numbered path across the canvas. It is a Nudge-level suggestion: it orders your fragments, never writes prose, and can be dismissed.
6. **Start drafting.** **Start drafting →** (or <kbd>⌘T</kbd> again) returns to the editor. The canvas is saved as `<document>.canvas`, and the right panel opens on **Material**, with fragments grouped by cluster. Only the group for the current paragraph is open; the others fold to one line each.
7. **While drafting.** Fragments the draft already covers are ticked automatically; unused ones stay visible. Drag a fragment onto the page to insert its text, which you then rewrite in your own sentence. Recall (<kbd>⌘1</kbd>) looks at this document's fragments first. You can return to the canvas at any time with <kbd>⌘T</kbd>.

**Edge cases:** with no model configured, links and clusters are unavailable and the canvas works as a plain free-form board. Deleting a fragment that's referenced in the draft only removes it from the canvas; the draft is never touched.

### 4. Using help mid-draft (⌘1–⌘5)

**Goal:** get exactly the amount of help you need, then return to writing with nothing left behind on the page.

The general shape is the same at every level:

1. **Ask.** Press the level's key. Help applies to the selection, or to the caret's word, sentence or paragraph if nothing is selected.
2. **See.** The suggestion appears where your attention already is: at the cursor, or beside the paragraph. A small label always names the level ("⌘3 · Word").
3. **Decide.** Accept, cycle to the next suggestion (press the same key again), or dismiss (<kbd>Esc</kbd>, or simply keep typing).
4. **Recorded.** The request and your decision are added to the Help module, anchored to the paragraph.

| Level | Typical moment | What you do |
|---|---|---|
| ⌘1 Recall | "I know I've written about this before." | Card under the line. <kbd>⌘↵</kbd> inserts a quote with its citation; "More" opens results in the Help module. |
| ⌘2 Nudge | Stuck, but you don't want words put in your mouth. | One question beside the paragraph. Resolve it, or ask for another. |
| ⌘3 Word | The word is almost right. | List of alternatives under the word. Arrows and <kbd>↵</kbd> to pick. |
| ⌘4 Sentence | You know where the sentence goes but not how. | Ghost text after the caret (or an inline diff if a sentence is selected). <kbd>Tab</kbd> accepts. |
| ⌘5 Passage | A paragraph needs reworking and you can say how. | Instruction bar ("make this less abstract"), then an inline diff (flow 5). |

**The ceiling.** If the requested level is above your help ceiling, Ekdanta shows a one-line notice instead of a suggestion: "Ceiling is 3 · press ⌘4 again to allow once." It never silently downgrades or exceeds the ceiling.

**Edge cases:** if there's no relevant material for Recall, the card says so plainly ("Nothing in your vault on this yet") rather than reaching for something weak. Errors (no network, a rejected key) appear in the same place as the suggestion would, with one action to fix them.

### 5. Reviewing a diff

**Goal:** see exactly what would change, and keep full control over every word.

1. A Sentence (⌘4, on a selection) or Passage (⌘5) result appears **inline**, in place of the original text: deletions struck through on a warm tint, insertions underlined in the accent colour. The text around it is untouched.
2. A compact control row sits under the changed block: **Accept all** <kbd>⌘↵</kbd> · **Reject all** <kbd>⌘⌫</kbd> · "3 changes".
3. **Per-change review.** <kbd>Tab</kbd> moves between individual changes. On each one, <kbd>↵</kbd> accepts and <kbd>⌫</kbd> rejects. Hovering a change shows its own ✓ and ✕.
4. **Refine.** Typing a new instruction into the bar (still open above the block) produces a fresh diff against the **original** text, not against the previous suggestion.
5. **Edit after accepting.** Once accepted, the text is ordinary text again. Any edits you make to it within the next minute are recorded as "edited after accept", the most useful signal of your taste.
6. **Undo.** <kbd>⌘Z</kbd> after accepting restores the original in one step.

The diff is always computed by code, word by word, from the original and the model's output. The model never decides what counts as a change.

### 6. Choosing and switching platform

**Goal:** the same idea written as an essay, a LinkedIn post or an email should be helped differently.

1. **On a new document,** a small inline picker under the title offers the platforms (Essay, LinkedIn, Email, Text, Blog). It defaults to the folder's usual platform, for example LinkedIn inside `linkedin/`. Pressing <kbd>↵</kbd> keeps the default.
2. **To switch later,** open the Piece module (<kbd>⌘⌥3</kbd>) and choose **switch** next to Platform, or click the platform in the meta line above the title.
3. **What changes:** the voice profile used for ⌘3–⌘5, the typical-length guide in the Piece module, and the norms Nudge applies (for example "LinkedIn posts usually open with one line"). **What doesn't change:** your text. Switching platform never rewrites anything.
4. **Adapting a piece** for another platform ("turn this essay into a LinkedIn post") is a separate, later feature. It creates a **new** document and shows its draft as a diff against nothing, so the original is never touched.

### 7. Viewing and editing the voice profile

**Goal:** see what Ekdanta "believes" about how you write, and correct it.

1. Open **Voice** from the rail, or click **view** next to the voice profile in the Piece module. The view lists one profile per platform, with its status ("Up to date", or "Out of date · Rebuild").
2. **The profile is a readable document**, for example "Short declarative openings. Rarely uses semicolons. Concrete examples before abstractions." Each trait links to two or three example passages from your exemplars that show it.
3. **Edit directly.** The profile is a Markdown file (`.ekdanta/voice/essay.md`). Delete a trait, rewrite it, or add your own ("Never use 'delve'"). Your edits are marked as yours and are kept through rebuilds.
4. **Sources and weights.** A sidebar lists the documents feeding this profile, with their weights (★ exemplars at the top). You can pin a document's weight higher, lower it, or exclude it.
5. **Rebuild** regenerates the traits from the current exemplars and weights. The result is shown as a diff against the current profile, and you accept or reject it like any other change.

### 8. Focus mode

**Goal:** remove every distraction, on demand.

1. Press <kbd>⌘.</kbd> (or choose Focus from the View menu). The rail, the right panel, the title bar and the status line fade out over about 150 ms. The page re-centres.
2. Other paragraphs dim to about 45%, so only the one you're writing in reads at full strength. This paragraph focus can be turned off in Settings.
3. Help keys still work. Suggestions appear exactly as in the editor and disappear with them. The Recall dot is hidden in Focus.
4. A faint "esc or ⌘. to exit focus" shows for three seconds on entry, then disappears.
5. Press <kbd>Esc</kbd> or <kbd>⌘.</kbd> to return. The editor comes back exactly as you left it, with the same panel module open.

## Open questions

- **Exemplar shortcut:** is <kbd>⌘⇧8</kbd> (the ★ key on US layouts) discoverable enough, or should starring live only in the UI?
- **Help history retention:** should resolved items in the Help module be cleared after a time, or kept for good as a record of how the piece was written?
- **Thinking Space for short pieces:** emails and texts rarely need a canvas. Should ⌘T be hidden for those platforms, or simply never suggested?
