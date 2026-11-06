# Ekdanta MVP

A first working version of Ekdanta: a local editor over a folder of Markdown files, with the five-level help ladder running on real models. It runs in the browser against a small local server; nothing leaves your machine except requests to the model provider you use.

## Run it

```sh
cd app
npm install
npm run dev          # http://127.0.0.1:5317
```

To write in your own folder (an Obsidian vault works) instead of the bundled sample:

```sh
EKDANTA_VAULT=~/path/to/vault npm run dev
```

Ekdanta stores its settings, index and help history in `.ekdanta/` inside the vault. It is safe to delete.

## Writing and the vault

Ekdanta writes plain Markdown but reads like a finished page, as in Obsidian's Live Preview: headings, lists, checkboxes, quotes, links, highlights and images show formatted, and the Markdown behind them stays out of sight (links show theirs while the caret is in them). The Markdown button at the end of the toolbar shows the source instead.

- **Toolbar**, laid out like Google Docs': undo and redo, text style, bold, italic, underline, strikethrough, highlight, inline code, link, bulleted, numbered and checklists, indent, Insert (divider, table, image, page link, date), clear formatting, and find and replace.
- **Type /** at the start of a line (or after a space) for any block, as in Notion: `/h1`, `/todo`, `/quote`, `/table`… Markdown typed directly works too: `# `, `- `, `1. `, `[] `, `> `, `---`.
- **Type [[** to link to another page. ⌘-click a link to open it, or put the caret in it for Open, Edit, Copy and Remove. A link to a page that doesn't exist yet creates it.
- **Select text** for a small bar with the inline styles.
- **Paste** keeps formatting from Google Docs and web pages, a URL pasted over selected words links them, and ⌘⇧V pastes plain text. Paste or drop an image and it is saved in `attachments/` in the vault.
- **Outline** (⌃⌥2) lists the page's headings; click one to go there. The status bar shows the selection's word count and reading time.

Each page in the sidebar has a ⋯ menu: **Rename** (double-click works too) renames the file and updates every `[[link]]` to it; **Move to…** files it in another folder, and moving it into a platform's folder makes it a piece for that platform; **Duplicate**; and **Delete**, which can be undone and keeps the page under **Recently deleted** (in `.ekdanta/trash/`) until you empty it. Changing a piece's platform moves it into that platform's folder, unless you filed it in a folder of your own.

## Models

Ekdanta uses whatever you already have. By default it picks, in this order:

1. **The Claude Code CLI**, if it's installed and signed in (`claude`). Ekdanta keeps a few sessions warm in the background and reads each answer as soon as it arrives, so a request takes about 1–2 s (⌘3 Word, on Haiku) or 2–5 s (⌘2, ⌘4, ⌘5, on Sonnet). Requests count against that login's usage.
2. **An Anthropic API key** in `ANTHROPIC_API_KEY`, billed per request.
3. **A local model through [Ollama](https://ollama.com)** (default `gemma4:12b`), for fully offline use.

⌘1 Recall runs inside the app on a small embedding model (bge-small, about 33 MB, downloaded once into `app/.cache/`). Nothing to install.

Settings (⌥,) can pin a provider, choose the Claude models, use the local model for ⌘3 only, or switch Recall to Ollama's `nomic-embed-text`. They're saved in `.ekdanta/settings.json` in the vault, so every device that opens the vault shares them. Environment variables set the defaults: `EKDANTA_CLAUDE_MODEL`, `EKDANTA_CLAUDE_FAST_MODEL`, `EKDANTA_OLLAMA_MODEL`, `EKDANTA_PREFER_LOCAL=1`, `EKDANTA_EMBEDDER=ollama`, `EKDANTA_DISABLE_CLAUDE_CLI=1` and `EKDANTA_RECALL_FLOOR`. API keys are only ever read from the environment.

## Voice profiles

Each platform gets a short, readable profile in `.ekdanta/voice/<platform>.md`, built from your ★ exemplars (topped up with recent pieces while there are fewer than three). Every trait quotes your own writing, and Ekdanta checks each quote against the source before keeping it. Edit the traits freely; anything under **Your rules** is yours and a rebuild never changes it. A rebuild is shown as a diff to accept or reject, and ⌘3–⌘5 follow the profile for the piece's platform. The profile opens as a formatted page; switch to Markdown to edit it.

## Thinking Space

⌥T opens a full-screen canvas for the open piece, for getting what's in your head out before (or while) drafting. Type fragments anywhere: Return starts the next one, a click puts one where you clicked, and dragging moves them. After a pause, Ekdanta suggests a few dashed links between related fragments ("same idea", "contradicts", "example of") and shows a chip where a fragment matches one of your notes. Click a link to remove it; hold ⌥ to hide them all. **Clusters** groups fragments into themes on request; click a label to rename it. Nothing is ever moved or rewritten.

**Start drafting** (⌥T again) returns to the page, with the fragments in the Material panel: the group nearest the paragraph you're writing is open, fragments the draft already covers are ticked, and you can drag one onto the page. You can keep thinking there without opening the canvas: add, edit or remove thoughts, tick one off by hand, group them into themes and rename a theme. A thought that matches one of your notes shows it underneath. The canvas is saved as `<piece>.canvas` in [JSON Canvas](https://jsoncanvas.org) format, so it opens in Obsidian too.

## Keys

Every shortcut below except the help ladder's can be changed in Settings → Keyboard shortcuts: click one and press the new keys. Ekdanta warns when keys are already taken, by another command (offering to swap) or by the browser or macOS.

The help levels are ⌘1–⌘5. Some browsers keep ⌘+number for switching tabs; there, use ⌥ (Option) instead. Ekdanta notices which one reaches it and labels everything to match.

| Keys | |
|---|---|
| ⌘1 · ⌘2 · ⌘3 · ⌘4 · ⌘5 | Recall · Nudge · Word · Sentence · Passage. The same key again gives the next suggestion. |
| ⌘3 | With nothing selected, options for the next word; with a selection, replacements for it |
| Esc | Dismiss (typing also dismisses, except a Nudge) |
| ↑↓ ↵ | Choose and pick in Recall and Word |
| Tab | Accept ghost text; in a diff, step through changes (↵ accept, ⌫ reject) |
| ⌘↵ / ⌘⌫ | Accept all / reject all |
| ⌥T | Thinking Space for the open piece (browsers keep ⌘T for a new tab) |
| ⌥N | New draft, in the current folder (browsers keep ⌘N for a new window) |
| ⌘B · ⌘I · ⌘U · ⌘⇧X | Bold · italic · underline · strikethrough |
| ⌘E · ⌘⇧H · ⌘K | Inline code · highlight · link |
| ⌘⇧0 · ⌘⇧1–3 | Normal text · heading 1–3 (on a Mac, ⌘⇧3 is the screenshot key: rebind Heading 3 in Settings) |
| ⌘⇧7 · ⌘⇧8 · ⌘⇧9 | Numbered list · bulleted list · checklist (⌘↵ ticks a to-do) |
| Tab · ⇧Tab · ⌘] · ⌘[ | Nest and un-nest list items |
| ⌘F | Find and replace |
| ⌘⇧V | Paste as plain text |
| ⌥⇧8 | Star the open piece as an exemplar (it sounds like you), or un-star it |
| ⌥, | Settings: help ceiling, models, appearance, the Recall index |
| ⌘. | Focus mode |
| ⌘\ · ⌃⌥1–4 | Right panel · Material, Outline, History, Piece |

## What's not here yet

Imports, the Thinking Space's possible order and dictation, and the Tauri desktop shell. See the [design documents](../design/) for where these are going.
