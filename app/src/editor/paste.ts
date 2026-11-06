// Pasting and dropping, as writers expect from Google Docs and Notion: formatting copied from the web
// or another editor comes along as Markdown, a link pasted over words links them, and images are
// saved into the vault. ⌘⇧V pastes plain text.
import { EditorView } from '@codemirror/view'
import TurndownService from 'turndown'
import { insertImage, insertLink } from './format.ts'

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', hr: '---' })
turndown.addRule('strike', { filter: ['del', 's'], replacement: (c) => (c.trim() ? `~~${c}~~` : c) })
turndown.addRule('underline', { filter: ['u', 'ins'], replacement: (c) => (c.trim() ? `<u>${c}</u>` : c) })
turndown.addRule('mark', { filter: ['mark'], replacement: (c) => (c.trim() ? `==${c}==` : c) })
// Google Docs marks formatting with inline styles, and wraps the whole paste in a <b> that isn't bold.
turndown.addRule('docs-wrapper', { filter: (n) => n.nodeName === 'B' && /docs-internal-guid/.test((n as HTMLElement).id), replacement: (c) => c })
turndown.addRule('styled-span', {
  filter: (n) => n.nodeName === 'SPAN' && !!(n as HTMLElement).getAttribute('style'),
  replacement: (content, n) => {
    const style = (n as HTMLElement).getAttribute('style') ?? ''
    if (!content.trim()) return content
    let out = content.trim()
    if (/font-weight:\s*(bold|[6-9]00)/.test(style)) out = `**${out}**`
    if (/font-style:\s*italic/.test(style)) out = `*${out}*`
    if (/line-through/.test(style)) out = `~~${out}~~`
    else if (/text-decoration[^;]*underline/.test(style) && !(n as HTMLElement).closest('a')) out = `<u>${out}</u>`
    // Keep the spaces the formatting sat between.
    return content.match(/^\s*/)![0] + out + content.match(/\s*$/)![0]
  },
})
turndown.addRule('checkbox', {
  filter: (n) => n.nodeName === 'INPUT' && (n as HTMLInputElement).type === 'checkbox',
  replacement: (_c, n) => ((n as HTMLInputElement).checked ? '[x] ' : '[ ] '),
})
// "- item", not Turndown's "-   item".
turndown.addRule('listItem', {
  filter: 'li',
  replacement: (content, node) => {
    const parent = node.parentNode as HTMLElement
    const index = Array.prototype.indexOf.call(parent.children, node)
    const start = Number(parent.getAttribute('start') ?? 1)
    const marker = parent.nodeName === 'OL' ? `${start + index}. ` : '- '
    const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n' + ' '.repeat(marker.length))
    return marker + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '')
  },
})
turndown.remove(['script', 'style', 'meta', 'title'])

const URL_ONLY = /^(https?:\/\/|mailto:)\S+$/i

function readAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export interface PasteOptions {
  /** Save an image into the vault; returns the path to link to. */
  saveImage: (name: string, base64: string) => Promise<string>
}

export async function addImages(view: EditorView, files: File[], opts: PasteOptions, at?: number) {
  for (const file of files.filter((f) => f.type.startsWith('image/'))) {
    const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png'
    const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${new Date().toISOString().slice(0, 10)}.${ext}`
    const src = await opts.saveImage(name, await readAsBase64(file))
    if (at !== undefined) view.dispatch({ selection: { anchor: at } })
    insertImage(src, name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '))(view)
  }
}

export function pasting(opts: PasteOptions) {
  let plain = false
  return [
    EditorView.domEventHandlers({
      keydown: (e) => {
        // ⌘⇧V: the next paste is plain text.
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'v') plain = true
        return false
      },
      paste: (e, view) => {
        const data = e.clipboardData
        if (!data) return false
        const wasPlain = plain
        plain = false
        const images = [...data.files].filter((f) => f.type.startsWith('image/'))
        if (images.length) {
          e.preventDefault()
          addImages(view, images, opts)
          return true
        }
        const text = data.getData('text/plain')
        const sel = view.state.selection.main
        // A link pasted over selected words links them (Notion, Google Docs).
        if (!sel.empty && URL_ONLY.test(text.trim())) {
          e.preventDefault()
          insertLink(text.trim())(view)
          return true
        }
        const html = data.getData('text/html')
        const formatted = /<(b|strong|i|em|u|s|del|a|h[1-6]|ul|ol|li|blockquote|pre|code|mark|table|img|span[^>]+style)\b/i.test(html)
        if (wasPlain || !html || !formatted) {
          return false // plain text: the editor's own paste
        }
        e.preventDefault()
        const md = turndown
          .turndown(html)
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        view.dispatch(view.state.replaceSelection(md))
        return true
      },
      drop: (e, view) => {
        const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!files.length) return false
        e.preventDefault()
        const at = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
        addImages(view, files, opts, at)
        return true
      },
    }),
  ]
}
