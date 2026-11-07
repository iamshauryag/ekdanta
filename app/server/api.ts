// HTTP API for the app, mounted on Vite's dev server. It binds to localhost; tailnet hosts can reach it
// through `tailscale serve`. Every route is answered only for the app's own page (see isSameOrigin): any
// other site the writer has open could otherwise write to their vault and spend their model quota, simply
// because the server is running. Routes that run programs or write outside the vault want local() as well,
// which is stricter — this machine only, never the tailnet.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { status } from './ai.ts'
import { claudePool, closeClaudePools } from './claude-pool.ts'
import { embedder, warmEmbedder } from './embed.ts'
import { applyPatch, joinFrontMatter, splitFrontMatter as splitFull, type MetaPatch } from '../src/lib/frontmatter.ts'
import { material, readThinking, recallChips, suggestClusters, suggestLinks, writeThinking, type Fragment } from './thinking.ts'
import { buildProfile, readProfile, summaries, writeProfile } from './voice.ts'
import { loadSettings, saveSettings, type Settings } from './settings.ts'
import { runHelp, type HelpRequest } from './help.ts'
import { doubledFolder } from '../src/lib/kinds.ts'
import { markBriefs, readBrief, writeBrief } from './brief.ts'
import { runEdge, type EdgeRequest } from './edge.ts'
import { captureIdea, listIdeas, starIdea, startIdea } from './ideas.ts'
import { runReader, type ReaderRequest } from './reader.ts'
import { HttpError, isLocalRequest, isSameOrigin, local, statusOf } from './net.ts'
import { addUpload, commit, convert, openBatch, preview, undo } from './import/index.ts'
import { exportDoc, pandoc, type ExportRequest } from './export.ts'
import { refresh, search, paragraphs } from './recall.ts'
import { checkOutside, keepBefore, listVersions, nameVersion, readVersion, snapshot } from './versions.ts'
import { applyTemplateTo, listTemplates, seedTemplates } from './templates.ts'
import { listSnippets, readSnippet } from './snippets.ts'
import {
  VAULT,
  MissingDoc,
  StaleWrite,
  appendHistory,
  changesSince,
  collectTouched,
  clearHistory,
  copySampleVault,
  vaultProblem,
  createDoc,
  discardIfEmpty,
  listFiles,
  listTrash,
  readAsset,
  saveAsset,
  moveToFolder,
  nameDoc,
  placeDoc,
  renameDoc,
  renameFolder,
  duplicateDoc,
  restoreDoc,
  trashDoc,
  readDoc,
  readHistory,
  readWithMtime,
  splitFrontMatter,
  writeDoc,
} from './vault.ts'

type Handler = (req: IncomingMessage, url: URL) => Promise<unknown>

/** The vault folder is missing and can't be made, is a file, or can't be written: the app shows why. */
class VaultUnavailable extends HttpError {
  readonly code = 'VAULT_UNAVAILABLE'
  constructor(reason: string) {
    super(503, reason)
  }
}

/** The bundled sample vault, wherever the server is started from. */
const SAMPLE_VAULT = fileURLToPath(new URL('../sample-vault', import.meta.url))

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

async function body<T>(req: IncomingMessage): Promise<T> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return JSON.parse(raw || '{}') as T
}

const routes: Record<string, Handler> = {
  'GET /api/status': async () => ({ ...(await status()), vault: VAULT, embedder: embedder().id }),
  'GET /api/settings': async () => loadSettings(),
  'PUT /api/settings': async (req) => {
    const prev = { ...(await loadSettings()) }
    const next = await saveSettings(await body<Partial<Settings>>(req))
    if (next.embedder !== prev.embedder)
      warmEmbedder()
        .then(() => refresh())
        .catch(() => {})
    if (next.claudeModel !== prev.claudeModel) warmClaude()
    if (next.claudeFastModel !== prev.claudeFastModel) warmClaude()
    if (JSON.stringify(next.excludedFolders) !== JSON.stringify(prev.excludedFolders)) refresh().catch(() => {})
    return next
  },
  'GET /api/snippets': async () => listSnippets(),
  // A missing or unreadable snippet is an expected state the app shows in Settings, not a failed request.
  'GET /api/snippet': async (_req, url) =>
    readSnippet(url.searchParams.get('path') ?? '').then(
      (css) => ({ css }),
      (e: Error) => ({ css: '', error: e.message }),
    ),
  'GET /api/files': async () => {
    const problem = await vaultProblem()
    if (problem) throw new VaultUnavailable(problem)
    return markBriefs(await listFiles())
  },
  // Fill an empty vault with the sample pieces (the welcome card offers it).
  'POST /api/vault/use-sample': local(async () => {
    try {
      const files = await copySampleVault(SAMPLE_VAULT)
      refresh().catch(() => {})
      return { files }
    } catch (e) {
      throw new HttpError(409, (e as Error).message)
    }
  }),
  // Import: a batch per visit to the Import sheet; files arrive one per request as raw bytes.
  'POST /api/import/batch': local(async () => openBatch()),
  'POST /api/import/upload': local(async (req) => addUpload(header(req, 'x-batch'), header(req, 'x-filename'), Number(header(req, 'x-mtime')), req)),
  'POST /api/import/convert': local(async (req) => {
    const { batch, id } = await body<{ batch: string; id: string }>(req)
    return convert(batch, id)
  }),
  'GET /api/import/preview': local(async (_req, url) => ({
    content: await preview(url.searchParams.get('batch') ?? '', url.searchParams.get('id') ?? '', url.searchParams.get('platform') ?? undefined),
  })),
  'POST /api/import/commit': local(async (req) => {
    const { batch, id, platform, folder } = await body<{ batch: string; id: string; platform?: string; folder?: string }>(req)
    const item = await commit(batch, id, { platform, folder })
    refresh().catch(() => {})
    return item
  }),
  'POST /api/import/undo': local(async (req) => {
    const { batch } = await body<{ batch: string }>(req)
    const result = await undo(batch)
    refresh().catch(() => {})
    return result
  }),
  'GET /api/file': async (_req, url) => {
    // Changed outside Ekdanta since we last wrote it? Keep both sides as versions before it's edited.
    const doc = await checkOutside(url.searchParams.get('path') ?? '')
    if (!doc) throw new HttpError(404, 'Not in the vault')
    return doc
  },
  // A save from the editor. With baseMtime, a file changed on disk since then isn't overwritten (409,
  // with what's there now). A file that has gone isn't brought back unless the writer asked (create).
  'PUT /api/file': async (req) => {
    const { path, content, baseMtime, create } = await body<{ path: string; content: string; baseMtime?: number; create?: boolean }>(req)
    if (typeof content !== 'string') throw new HttpError(400, 'No content')
    try {
      const { mtime } = await writeDoc(path, content, { baseMtime: typeof baseMtime === 'number' ? baseMtime : undefined, create: create === true })
      refresh().catch(() => {}) // re-index in the background
      return { ok: true, mtime }
    } catch (e) {
      if (e instanceof StaleWrite) throw new HttpError(409, 'Changed on disk', { mtime: e.mtime, content: e.content })
      if (e instanceof MissingDoc) throw new HttpError(404, 'Not in the vault')
      throw e
    }
  },
  // What changed in the vault since the last poll, from file stats alone.
  'GET /api/changes': async (_req, url) => {
    const since = url.searchParams.get('since')
    return changesSince(since === null || since === '' ? undefined : Number(since))
  },
  'POST /api/new': async (req) => {
    const { folder, platform } = await body<{ folder?: string; platform?: string }>(req)
    return { path: await createDoc((await loadSettings()).kinds, folder ?? '', platform) }
  },
  // Routes that change documents answer with `touched`: every document they wrote or moved, and its
  // new mtime, so the app can take in a change to the open document without calling it a conflict.
  'POST /api/name': async (req) => {
    const { path, title } = await body<{ path: string; title: string }>(req)
    const { result: next, touched } = await collectTouched(() => nameDoc(path, title))
    if (next !== path) refresh().catch(() => {})
    return { path: next, touched }
  },
  'POST /api/place': async (req) => {
    const { path } = await body<{ path: string }>(req)
    await keepBefore(path, 'before move')
    const kinds = (await loadSettings()).kinds
    const { result: next, touched } = await collectTouched(() => placeDoc(kinds, path))
    if (next !== path) refresh().catch(() => {})
    return { path: next, touched }
  },
  'POST /api/rename': async (req) => {
    const { path, title } = await body<{ path: string; title: string }>(req)
    await keepBefore(path, 'before rename')
    const { result: next, touched } = await collectTouched(() => renameDoc(path, title))
    refresh().catch(() => {})
    return { path: next, touched }
  },
  'POST /api/move': async (req) => {
    const { path, folder } = await body<{ path: string; folder: string }>(req)
    await keepBefore(path, 'before move')
    const kinds = (await loadSettings()).kinds
    const { result: next, touched } = await collectTouched(() => moveToFolder(kinds, path, folder))
    refresh().catch(() => {})
    return { path: next, touched }
  },
  'POST /api/duplicate': async (req) => {
    const { path } = await body<{ path: string }>(req)
    const { result: next, touched } = await collectTouched(() => duplicateDoc(path))
    return { path: next, touched }
  },
  'POST /api/delete': async (req) => {
    const { path } = await body<{ path: string }>(req)
    await keepBefore(path, 'before delete')
    const item = await trashDoc(path)
    refresh().catch(() => {})
    return item
  },
  'POST /api/asset': async (req) => {
    const { doc, name, data } = await body<{ doc: string; name: string; data: string }>(req)
    return { src: await saveAsset(doc, name, data) }
  },
  'GET /api/trash': async () => listTrash(),
  'POST /api/restore': async (req) => {
    const { id } = await body<{ id: string }>(req)
    const { result: path, touched } = await collectTouched(() => restoreDoc(id))
    refresh().catch(() => {})
    return { path, touched }
  },
  'POST /api/discard': async (req) => {
    const { path } = await body<{ path: string }>(req)
    return { discarded: await discardIfEmpty(path) }
  },
  'POST /api/help': async (req) => runHelp(await body<HelpRequest>(req)),
  // The brief pinned beside a document (kept in .ekdanta, never in the document). An empty one unpins.
  'GET /api/brief': async (_req, url) => ({ text: await readBrief(url.searchParams.get('doc') ?? '') }),
  'PUT /api/brief': async (req) => {
    const { doc, text } = await body<{ doc: string; text: string }>(req)
    return { text: await writeBrief(doc, text) }
  },
  // A subject, title, excerpt or opening line drawn from the draft.
  'POST /api/edge': async (req) => runEdge(await body<EdgeRequest>(req)),
  // Read as…: questions a named reader would ask, each tied to a phrase. Never changes the document.
  'POST /api/reader': async (req) => runReader(await body<ReaderRequest>(req)),
  // Background check for the Recall dot: is there anything strong for this paragraph?
  'POST /api/recall-probe': async (req) => {
    const { text, doc } = await body<{ text: string; doc: string }>(req)
    if (paragraphs(text).length === 0) return { strong: false }
    const hits = await search(text, { exclude: doc, limit: 1 })
    return { strong: hits.length > 0 && hits[0].score >= embedder().strong }
  },
  'POST /api/index': async () => {
    const ix = await refresh()
    return { files: Object.keys(ix.files).length, paragraphs: ix.chunks.length }
  },
  'GET /api/history': async (_req, url) => readHistory(url.searchParams.get('doc') ?? ''),
  'POST /api/history': async (req) => {
    const { doc, item } = await body<{ doc: string; item: unknown }>(req)
    await appendHistory(doc, item)
    return { ok: true }
  },
  'DELETE /api/history': async (_req, url) => {
    await clearHistory(url.searchParams.get('doc') ?? '')
    return { ok: true }
  },
  // A kind whose folder doubled its plural (yt-scriptses/): move its pieces into the proper folder, then file there.
  'POST /api/kinds/rename-folder': async (req) => {
    const { id } = await body<{ id: string }>(req)
    const { kinds } = await loadSettings()
    const kind = kinds.find((k) => k.id === id)
    const to = kind && doubledFolder(kind)
    if (!kind || !to) throw new Error('That kind’s folder needs no renaming')
    const owner = kinds.find((k) => k !== kind && k.folder === to)
    if (owner) throw new Error(`${to}/ is already the ${owner.name} folder`)
    const { result: moved, touched } = await collectTouched(() => renameFolder(kind.folder, to))
    const settings = await saveSettings({ kinds: kinds.map((k) => (k === kind ? { ...k, folder: to } : k)) })
    refresh().catch(() => {})
    return { settings, moved, touched }
  },
  // Front-matter changes to a document that isn't open in the editor (starring it from the Vault, say).
  'POST /api/meta': async (req) => {
    const { path, patch } = await body<{ path: string; patch: MetaPatch }>(req)
    const { touched } = await collectTouched(async () => {
      const { meta, body: text, raw } = splitFull(await readDoc(path))
      await writeDoc(path, joinFrontMatter(raw, applyPatch(meta, patch), text), { reason: 'meta' })
    })
    return { ok: true, touched }
  },
  'GET /api/voice': async () => summaries(),
  'GET /api/voice/profile': async (_req, url) => ({ content: await readProfile(url.searchParams.get('platform') ?? '') }),
  'PUT /api/voice/profile': async (req) => {
    const { platform, content } = await body<{ platform: string; content: string }>(req)
    await writeProfile(platform, content)
    return { ok: true }
  },
  'POST /api/voice/build': async (req) => {
    const { platform } = await body<{ platform: string }>(req)
    return { content: await buildProfile(platform) }
  },
  'GET /api/thinking': async (_req, url) => readThinking(url.searchParams.get('doc') ?? ''),
  'PUT /api/thinking': async (req) => {
    const { doc, canvas, side } = await body<{ doc: string; canvas: Parameters<typeof writeThinking>[1]; side: unknown }>(req)
    await writeThinking(doc, canvas, side)
    return { ok: true }
  },
  'POST /api/thinking/links': async (req) => {
    const { fragments, skip } = await body<{ fragments: Fragment[]; skip?: string[] }>(req)
    return { links: await suggestLinks(fragments, skip) }
  },
  'POST /api/thinking/clusters': async (req) => {
    const { fragments } = await body<{ fragments: Fragment[] }>(req)
    return { clusters: await suggestClusters(fragments) }
  },
  'POST /api/thinking/recall': async (req) => {
    const { doc, fragments, taken } = await body<{ doc: string; fragments: Fragment[]; taken?: string[] }>(req)
    return { chips: await recallChips(doc, fragments, taken) }
  },
  'POST /api/thinking/material': async (req) => {
    const { doc, fragments, paragraph } = await body<{ doc: string; fragments: Fragment[]; paragraph: string }>(req)
    return material(doc, fragments, paragraph ?? '')
  },
  'GET /api/versions': async (_req, url) => listVersions(url.searchParams.get('doc') ?? ''),
  'GET /api/version': async (_req, url) => ({ content: await readVersion(url.searchParams.get('doc') ?? '', url.searchParams.get('id') ?? '') }),
  'POST /api/versions/snapshot': async (req) => {
    const { doc, name, reason, content } = await body<{ doc: string; name?: string; reason?: string; content?: string }>(req)
    return { version: await snapshot(doc, { name, content: typeof content === 'string' ? content : undefined, reason: String(reason || (name ? 'saved by you' : 'snapshot')).slice(0, 60) }) }
  },
  'POST /api/versions/name': async (req) => {
    const { doc, id, name } = await body<{ doc: string; id: string; name: string }>(req)
    return { version: await nameVersion(doc, id, String(name ?? '')) }
  },
  'GET /api/templates': async () => listTemplates(),
  // Fill an empty new piece from a template: front matter merged, body filled in.
  'POST /api/templates/apply': async (req) => {
    const { path, template } = await body<{ path: string; template: string }>(req)
    const { result, touched } = await collectTouched(() => applyTemplateTo(path, template))
    refresh().catch(() => {})
    return { ...result, touched }
  },
  // The starter set, written only when the writer asks; files already there are never replaced.
  'POST /api/templates/seed': async () => seedTemplates(),
  'GET /api/meta': async (_req, url) => splitFrontMatter(await readDoc(url.searchParams.get('path') ?? '')).meta,
  // Which engine makes Word files: pandoc (run on this machine) or the built-in one.
  'GET /api/export/engine': local(async () => {
    const p = await pandoc()
    return { pandoc: p?.version ?? null }
  }),
  // Ideas: ideas.md at the top of the vault, only ever appended to; stars are the app's own.
  'GET /api/ideas': async () => listIdeas(),
  'POST /api/ideas': async (req) => {
    const { text } = await body<{ text: string }>(req)
    const { result, touched } = await collectTouched(() => captureIdea(typeof text === 'string' ? text : ''))
    return { ...result, touched }
  },
  'POST /api/ideas/star': async (req) => {
    const { text, starred } = await body<{ text: string; starred: boolean }>(req)
    return starIdea(typeof text === 'string' ? text : '', !!starred)
  },
  'POST /api/ideas/start': async (req) => {
    const { text, kind } = await body<{ text: string; kind: string }>(req)
    return { path: await startIdea((await loadSettings()).kinds, typeof text === 'string' ? text : '', typeof kind === 'string' ? kind : '') }
  },
}

/** Keep a version before the server moves or rewrites a document. A failure never blocks the move. */

/** Start the Claude sessions the current settings will use, if Claude is the one answering. */
function warmClaude() {
  status().then((s) => {
    if (s.fast === 'claude-cli') claudePool(s.models.claudeFast, 'low').warm()
    if (s.strong === 'claude-cli') claudePool(s.models.claude, 'medium').warm()
  })
}

export function ekdantaApi(): Plugin {
  return {
    name: 'ekdanta-api',
    configureServer(server) {
      // A vault folder that doesn't exist yet is made now; one that can't be used is reported by /api/files.
      vaultProblem().then((problem) => problem && server.config.logger.warn(`Vault ${VAULT} can’t be used: ${problem}`))
      // Load the embedding model and build the Recall index up front, so the first ⌘1 is quick.
      loadSettings()
        .then(() => warmEmbedder())
        .then(() => refresh())
        .catch((e) => server.config.logger.warn(`Recall index not built: ${(e as Error).message}`))
      // Warm the Claude sessions too, and close them when the server stops or restarts.
      warmClaude()
      server.httpServer?.once('close', closeClaudePools)
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith('/api/')) return next()
        // Checked here rather than per route, so a route added later can't be the one that forgets.
        if (!isSameOrigin(req)) {
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          return res.end(JSON.stringify({ error: 'Only available from the app' }))
        }
        const url = new URL(req.url, 'http://localhost')
        // Images are served as themselves, not as JSON.
        if (req.method === 'GET' && url.pathname === '/api/asset') {
          try {
            const { type, data } = await readAsset(url.searchParams.get('path') ?? '')
            res.setHeader('content-type', type)
            res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
            return res.end(data)
          } catch {
            res.statusCode = 404
            return res.end()
          }
        }
        // An export comes back as the file itself, like an image; saved into the vault, as JSON.
        if (req.method === 'POST' && url.pathname === '/api/export') {
          try {
            // It may run pandoc and writes outside documents, so only from this computer.
            if (!isLocalRequest(req)) throw new HttpError(403, 'Only available on this computer')
            const r = await exportDoc(await body<ExportRequest>(req))
            const info = { name: r.name, engine: r.engine, warnings: r.warnings, saved: r.saved ?? null }
            if (r.saved) {
              res.setHeader('content-type', 'application/json')
              return res.end(JSON.stringify(info))
            }
            res.setHeader('content-type', r.type)
            res.setHeader('content-disposition', `attachment; filename="${r.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(r.name)}`)
            res.setHeader('x-ekdanta-export', encodeURIComponent(JSON.stringify(info)))
            return res.end(r.data)
          } catch (e) {
            res.statusCode = statusOf(e)
            res.setHeader('content-type', 'application/json')
            return res.end(JSON.stringify({ error: (e as Error).message }))
          }
        }
        const handler = routes[`${req.method} ${url.pathname}`]
        if (!handler) return next()
        try {
          const result = await handler(req, url)
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(result))
        } catch (e) {
          res.statusCode = statusOf(e)
          res.setHeader('content-type', 'application/json')
          const code = e instanceof HttpError && 'code' in e ? e.code : undefined
          res.end(JSON.stringify({ ...(e instanceof HttpError ? e.data : undefined), error: (e as Error).message, code }))
        }
      })
    },
  }
}
