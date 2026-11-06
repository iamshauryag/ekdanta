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

## Models

Ekdanta uses whatever you already have. By default it picks, in this order:

1. **The Claude Code CLI**, if it's installed and signed in (`claude`). Ekdanta keeps a few sessions warm in the background and reads each answer as soon as it arrives, so a request takes about 1–2 s (⌘3 Word, on Haiku) or 2–5 s (⌘2, ⌘4, ⌘5, on Sonnet). Requests count against that login's usage.
2. **An Anthropic API key** in `ANTHROPIC_API_KEY`, billed per request.
3. **A local model through [Ollama](https://ollama.com)** (default `gemma4:12b`), for fully offline use.

⌘1 Recall runs inside the app on a small embedding model (bge-small, about 33 MB, downloaded once into `app/.cache/`). Nothing to install.

Settings (⌥,) can pin a provider, choose the Claude models, use the local model for ⌘3 only, or switch Recall to Ollama's `nomic-embed-text`. They're saved in `.ekdanta/settings.json` in the vault, so every device that opens the vault shares them. Environment variables set the defaults: `EKDANTA_CLAUDE_MODEL`, `EKDANTA_CLAUDE_FAST_MODEL`, `EKDANTA_OLLAMA_MODEL`, `EKDANTA_PREFER_LOCAL=1`, `EKDANTA_EMBEDDER=ollama`, `EKDANTA_DISABLE_CLAUDE_CLI=1` and `EKDANTA_RECALL_FLOOR`. API keys are only ever read from the environment.

## Voice profiles

Each platform gets a short, readable profile in `.ekdanta/voice/<platform>.md`, built from your ★ exemplars (topped up with recent pieces while there are fewer than three). Every trait quotes your own writing, and Ekdanta checks each quote against the source before keeping it. Edit the traits freely; anything under **Your rules** is yours and a rebuild never changes it. A rebuild is shown as a diff to accept or reject, and ⌘3–⌘5 follow the profile for the piece's platform.

## Thinking Space

⌥T opens a full-screen canvas for the open piece, for getting what's in your head out before (or while) drafting. Type fragments anywhere: Return starts the next one, a click puts one where you clicked, and dragging moves them. After a pause, Ekdanta suggests a few dashed links between related fragments ("same idea", "contradicts", "example of") and shows a chip where a fragment matches one of your notes. Click a link to remove it; hold ⌥ to hide them all. **Clusters** groups fragments into themes on request; click a label to rename it. Nothing is ever moved or rewritten.

**Start drafting** (⌥T again) returns to the page, with the fragments in the Material panel: the group nearest the paragraph you're writing is open, fragments the draft already covers are ticked, and you can drag one onto the page. The canvas is saved as `<piece>.canvas` in [JSON Canvas](https://jsoncanvas.org) format, so it opens in Obsidian too.

## Keys

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
| ⌥⇧8 | Star the open piece as an exemplar (it sounds like you), or un-star it |
| ⌥, | Settings: help ceiling, models, appearance, the Recall index |
| ⌘. | Focus mode |
| ⌘\ · ⌘⌥1–3 | Right panel · Material, History, Piece |

## What's not here yet

Imports, the Thinking Space's possible order and dictation, and the Tauri desktop shell. See the [design documents](../design/) for where these are going.
