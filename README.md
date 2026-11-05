# Ekdanta

**Cursor + Obsidian for everyday writing.** A local-first writing app that knows your notes and your voice, and helps only when you ask, only as much as you ask.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/editor-dark.png">
  <img alt="The Ekdanta editor: a draft essay in a serif typeface, with a side panel listing the writer's own thinking fragments and pinned notes." src="docs/images/editor-light.png">
</picture>

> **Status: design phase.** There is no runnable app yet. The product spec, design brief and mockups are below; a clickable prototype comes next.

## Why

Most AI writing tools do too much. They finish the page for you, and in doing so they take the thinking away. Ekdanta is built the other way round. The page belongs to the writer, the AI stays silent by default, and when you do ask for help you choose exactly how much.

## The help ladder

Help is a ladder of five levels, each one keystroke away. Nothing appears while you type. Every suggestion comes because you asked for it.

| Key | Level | What you get |
|---|---|---|
| <kbd>⌘1</kbd> | **Recall** | Your own material: a note, a highlight, a past paragraph, always with its source |
| <kbd>⌘2</kbd> | **Nudge** | One question or direction, never prose |
| <kbd>⌘3</kbd> | **Word** | A few alternatives for the word you're on |
| <kbd>⌘4</kbd> | **Sentence** | A continuation or rewrite of one sentence, shown as a diff |
| <kbd>⌘5</kbd> | **Passage** | A rewrite of a selected passage on your instruction, shown as a diff |

You can set a ceiling ("never above level 3 unless I ask"). Generating whole pages is deliberately not a feature.

## Principles

- **Nothing changes without a diff.** Every edit to your words is a word-level diff you accept or reject, and the diff is computed by code, not by the model.
- **Show the source.** Anything drawn from your knowledge links back to the note or highlight it came from.
- **Your voice, per platform.** Ekdanta learns how you write essays, posts, emails and messages from the pieces you mark as your best, and keeps that profile in a file you can read and edit.
- **Think before drafting.** A Thinking Space lets you dump loose fragments on a canvas. Ekdanta links and clusters them but never rewrites them.
- **Your files, plainly.** Plain Markdown, YAML front-matter and [JSON Canvas](https://jsoncanvas.org) in a folder you own. Ekdanta is compatible with [Obsidian](https://obsidian.md) vaults.
- **Private by default.** Ekdanta is local-first, with no hosted backend and no telemetry. Bring your own model key (Anthropic, OpenAI, Google) or run models locally with Ollama.

## Documents

- [Product specification](docs/SPEC.md): vision, AI approach, architecture and MVP scope
- [Design brief](design/BRIEF.md): principles, the help ladder in detail, visual direction and the editor layout
- [Mockups](design/mockups/): static HTML mockups of the editor (open them in a browser)

## Planned stack

A [Tauri](https://tauri.app) desktop app with a React and TypeScript UI and a TipTap/ProseMirror editor. Desktop comes first, and a browser build later.

## License

[MIT](LICENSE) © 2026 Shaurya Gupta
