# Ekdanta — Product Specification

_Draft v0.3 · November 2026_

> **Ekdanta** (Sanskrit, "the one-tusked") is a name of Ganesha, who, in one telling, broke off his own tusk to keep writing the Mahabharata without pause. The name is a working title.

## Vision

Ekdanta is an open-source, local-first writing app — a "Cursor for writers". It aims to become the writer's **central home for all their writing**, arranged sensibly; to **learn their knowledge** (books read, quotes kept, ideas noted) and **how they write** on each platform; and to **help only when asked, and only as much as asked**, drawing on their own material first and the wider world second.

Most AI writing tools do too much: they finish the page and take the thinking away. Ekdanta does the opposite.

## Core principle: restraint

The AI is a collaborator, not a ghostwriter. The default is silence. Help scales with the writer's request:

| Level | What the AI does | Example |
|---|---|---|
| 0 Silent | Nothing (at most a faint margin dot when it has something relevant) | — |
| 1 Recall | Surfaces *your own* material: a note, a quote, a past paragraph | "You wrote about this in March" |
| 2 Nudge | A question or a direction, never prose | "What's the counter-argument?" |
| 3 Word | A few candidate words: replacements for a selected word, or the next word at the cursor | Three alternatives for "ripple" |
| 4 Sentence | Continues or rewrites one sentence, shown as a diff | — |
| 5 Passage | Rewrites a paragraph or section on explicit instruction, shown as a diff | — |

The writer sets a default ceiling (for example "never above level 3 unless I ask"). Generating whole pages is not a feature.

**Shortcuts.** Each level is one keystroke, because a writer needs different help at different moments in the same document: **Cmd+1** Recall, **Cmd+2** Nudge, **Cmd+3** Word, **Cmd+4** Sentence, **Cmd+5** Passage; **Esc** or **Cmd+0** dismisses. Pressing the same key again cycles to the next suggestion at that level. Some browsers keep Cmd/Ctrl+1–9 for switching tabs, so Option/Alt+1–5 always works as well; the app notices which one reaches it and labels shortcuts to match. All bindings are remappable.

## Cursor → writing

| Cursor | Ekdanta |
|---|---|
| Codebase | The writer's vault: all their writing as plain files on disk |
| Codebase index and retrieval | An index of their writing and knowledge (books, highlights, quotes, notes, ideas) |
| Coding style | A voice profile, learned per kind of writing (essay, LinkedIn post, email, or any kind the writer adds) |
| Tab completion | Short continuation — **only on request** (level 4) |
| Cmd+K inline edit | Select → instruct → word-level diff → accept or reject |
| Chat panel (Cmd+L) | The Assistant tab in the right panel: a chat about the open piece whose edits come back as proposals |
| Agent | Bounded tasks across files: "turn this essay into a LinkedIn post", "find every place I've used this idea" |
| @-mentions | @book, @note, @quote, @web to pull in sources deliberately |
| Linter | Optional checks: unsupported claims, repeated ideas, misquotes, tone drift for the platform |
| Tests | No ground truth; the writer's own accept/reject history stands in as the signal of their taste, and claims are checked against sources |

## Thinking Space (before drafting)

Before drafting, the writer dumps what's in their head — what they want to say, related ideas, half-thoughts — in plain or broken words, **not** as a bullet outline. The app connects the fragments.

- **Input:** type fragments anywhere on a loose canvas, or speak them (local speech-to-text). No formatting or hierarchy required. Links and quotes can be pasted in.
- **Connecting (AI, restrained):** embeddings and a model find relations between fragments ("the same idea", "contradicts", "an example of") and draw soft links. Fragments are also linked to the knowledge vault (a highlight, a past post) as Recall. The AI **never rewrites fragments**; it only groups, links and labels clusters with a word or two.
- **Views:** loose map (default), clusters, and "possible order" — a suggested arc, only on request.
- **Into drafting:** the map stays available beside the document. Fragments used in the draft are marked as covered; unused ones stay visible. Recall draws on this document's thinking first.
- **Storage:** a plain file next to the draft in [JSON Canvas](https://jsoncanvas.org) format, so it opens in Obsidian too.
- **Prior art:** Obsidian Canvas, Heptabase, Kinopio, Tana.

## Obsidian compatibility

[Obsidian](https://obsidian.md) stores notes as a folder of plain Markdown files (a "vault"). It is strong for collecting and linking notes and weaker for drafting: long-form writing usually relies on plugins, and many writers outline in Obsidian and then draft elsewhere. Existing AI plugins (related-notes search, chat over the vault, text generation) read notes at query time but build no lasting model of the writer, and none offers a restraint model, per-platform voice or diff-first editing.

Ekdanta treats an Obsidian vault as a first-class home:

1. **Read the vault directly.** It is just a folder: index notes, `[[wikilinks]]`, tags and front-matter, and optionally write drafts back into it. Works whether or not Obsidian is open. This is the primary path.
2. **Live link (optional).** Through community local-API plugins, for "open in Obsidian" and active-file context.
3. **Companion plugin (later).** Cmd+1–5 help inside Obsidian itself.

## AI approach

No model training in v1.

- **Recall (1):** local embeddings and semantic search over the vault and highlights. No generation; always cited.
- **Nudge (2):** the model returns one question, never prose.
- **Word (3):** a small, fast model returns 3–5 candidates.
- **Sentence and Passage (4–5):** a stronger model, given the instruction, the surrounding text, the voice profile and 3–5 retrieved samples of the writer's own similar writing. The output always passes through a deterministic diff.
- **Voice profile:** generated per platform from the writer's corpus into a readable, editable file.
- **Taste:** accept/reject decisions are stored locally and used as examples in prompts. Later, optionally, a small local model or adapter could be fine-tuned per writer.
- **Providers:** whatever the writer already has, in this order:
  1. **A signed-in AI CLI** (Claude Code today; Codex and Gemini CLI planned). Ekdanta keeps a few sessions warm and reads each answer as soon as it arrives, so a request takes about 1–2 s for Word and 2–5 s for longer help. Requests count against the writer's own plan.
  2. **An API key** (Anthropic, OpenAI or Google), billed per request.
  3. **A local model through Ollama**, for fully offline use.

  A fast tier (a small model such as Claude Haiku) serves Word; a strong tier (such as Claude Sonnet) serves Nudge, Sentence and Passage.
- **Embeddings:** Recall uses a small embedding model that runs inside the app (bge-small, about 33 MB, downloaded once). There is nothing to install, and nothing leaves the machine for Recall.

## The Assistant

A permanent **Assistant** tab in the right panel (Ctrl+Alt+5, or *Panel: Assistant* in the command palette) for talking about the piece that's open, the way Cursor's chat sits beside the code. It is the help ladder in conversation form, under the same rules.

- **What it knows.** The draft as it is on the page, unsaved edits included; the selection, shown as a chip the writer can remove before asking; the title, kind, pinned brief and the voice profile for that kind. Recall finds up to three of the writer's own notes for each ask (never highlights from the Brain); the notes the model says it drew on come back as chips that open them.
- **It never edits.** A change to the text comes back as a proposal: the exact words it replaces and what they become, shown as a word diff in the chat. *Accept* applies it as one step that Cmd+Z takes back; *Review on page* shows it with the help ladder's own diff (Tab, ↵, ⌫ for each change, Cmd+↵ for all). Several proposals can be accepted or reviewed together. Every decision goes into the help log. A proposal only ever replaces text that is in the draft: the server checks each one against the draft before the writer sees it, and the page finds it again in the text as it is now (or says it has changed).
- **The help ceiling holds, on the server too.** 0: off. 1: Recall only, the writer's own notes and no model. 2: questions and directions, no wording and no proposals. 3: a word or short phrase per change. 4: one sentence per change. 5: passages. Proposals past the ceiling are dropped and counted; *Allow once* asks the same again at level 5, once, as pressing a help key twice does. A proposal that would replace most of the piece is dropped unless the writer asked for the whole piece in so many words.
- **Its language.** It answers in plain words, in the language the writer asks in, briefly. Options the writer asked for (hooks, titles, angles) come as a list in the reply, not as edits.
- **Conversations.** One per document, kept in `.ekdanta/assistant/` under the document's key, so it follows the document through rename, move, trash and restore. *New chat* clears it.
- **While it works.** No streaming: a progress line and Stop. An answer that arrives after Stop is never saved. With no model available, the tab says so and how to set one up.
- **Safety.** Its routes answer only this computer, bodies are capped (1 MB; a 4,000-character ask; a 200,000-character draft), and the model runs with no tools.

## Weighting the writer's past work

Not every document — or sentence — represents a writer equally well. Weighting decides which past writing best represents their voice on each platform, and which knowledge to surface.

- **Document signals:** recency (voices evolve); the writer's own ★ exemplar marking (the strongest signal); finished or published versus draft; sole authorship versus co-written, quoted or templated; effort (revisions, time spent); platform.
- **Sentence signals:** discard boilerplate, quotations, greetings and sign-offs, and lists of facts; up-weight distinctive sentences (those least like generic model prose), sentences kept through revisions, and openings and closings.
- **Feedback:** accepted suggestions, and edits made after accepting, re-weight the sources that produced them; rejections down-weight.
- **Per platform:** separate weights per platform; one document can count for several.
- **Output:** a ranked exemplar set per platform for voice prompts, and a separate relevance ranking for Recall. Weights are stored in front-matter or a sidecar file, so they can be inspected and edited.
- **v1:** manual ★ exemplars, platform tag, recency and an "own writing only" filter. Distinctiveness scoring and feedback learning come in v2.

## Importing existing writing

- The official [Obsidian Importer](https://github.com/obsidianmd/obsidian-importer) (MIT) covers Apple Notes, Notion, Evernote, Google Keep, OneNote, Bear, Roam, Logseq, HTML, Markdown and more, but not Word or Google Docs.
- Word (.docx) and Google Docs (exported as .docx) convert with [Pandoc](https://pandoc.org): `pandoc in.docx -t gfm -o out.md --extract-media=media`. PDFs fall back to text extraction.
- First sources to support: **Google Docs, Word and Google Keep**.
- Ekdanta's importer adds front-matter to each file: original creation date (export tools often reset file dates), source app, platform (guessed, then confirmed by the writer) and title.

## Knowledge layer

- **Imports:** Kindle highlights, Readwise, Apple Books, PDFs and EPUBs, web clippings, notes exported from other apps, past posts, and (opt-in) sent email.
- Every suggestion that draws on knowledge shows its source as a citation chip. No unsourced "facts".
- World knowledge via web search is always labelled as external.

## Learning the writer

- A voice profile per platform, built from the writer's own corpus.
- Learning from accept, reject and edit-after-accept, stored locally.
- The writer can read and edit everything the app "believes" about their style. It is a file, not a black box.

## Surfaces

- **Home:** a desktop editor over the local vault.
- **Later:** a browser build, and a browser extension that brings the same voice and knowledge to Gmail, LinkedIn and X, with drafts saved back to the vault.

## Architecture

- **Storage:** local-first. Plain Markdown with YAML front-matter, `[[wikilinks]]`, and JSON Canvas for thinking maps, in a folder the writer owns. A search index (SQLite and embeddings) lives alongside it and can always be rebuilt.
- **App:** a [Tauri](https://tauri.app) desktop app with a React and TypeScript UI. A browser build shares the same codebase (using the File System Access API for local folders). The MVP runs in the browser against a small local server. The editor is [ProseMirror](https://prosemirror.net) (through [TipTap](https://tiptap.dev)): like Google Docs and Notion, it keeps the page as a structured document with formatting as part of the text, so edits can never leave broken Markdown behind. Markdown is the file format only: a page is parsed when it opens and written back when it changes, every untouched block byte for byte as it was, edited blocks in standard Markdown. Help suggestions and diffs are drawn as editor decorations, so the writer's text is untouched until they accept a change.
- **Core package:** retrieval, voice profile, restraint policy, the diff engine (deterministic, never the model) and provider adapters.
- **Privacy:** no hosted backend and no telemetry in v1.

## MVP

1. **Vault:** open a folder of Markdown files, with a file tree and the editor.
2. **Knowledge import:** highlights and notes, indexed locally.
3. **Recall:** suggestions from the writer's own material, with sources.
4. **Inline edit:** select → instruct → word-level diff → accept or reject.
5. **Voice:** a first voice profile from the writer's corpus, plus the help ceiling setting.

Later: on-request continuation, agent tasks, web search, the browser extension, linter checks.

**Status:** a first version is in [`app/`](../app/). It has the vault and editor with new drafts, all five help levels on real models (with Recall over the writer's own notes), word-level diff review, the help ceiling, Focus mode, Settings, ★ exemplars, per-platform voice profiles and the Thinking Space. Knowledge import comes next.

## Non-goals (v1)

Full-page or essay generation · team collaboration · hosted accounts and billing · AI-detection evasion.

## Decisions

- **Storage format:** Obsidian-compatible vault (Markdown, YAML front-matter, wikilinks, JSON Canvas).
- **License:** MIT.
- **Platform:** desktop first (Tauri); browser build later.
- **First user:** the project starts as a tool its author uses daily for essays, posts, emails and messages. Success means reaching a draft you're proud of faster, in your own voice.

## Open questions

- **Provider terms:** before the public release recommends signing in through an AI CLI, check each provider's current terms for third-party apps that use a personal plan.

- Which knowledge sources to support after Google Docs, Word and Keep (Kindle, Readwise, Notion, Apple Notes)?
- Final name.
