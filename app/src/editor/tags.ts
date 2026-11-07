// Inline #tags, styled as chips. Only a decoration: the text itself stays exactly as typed.
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { tagsInText } from '../lib/tags.ts'

// Headings and code can't hold tags; neither can code or link text inside a paragraph.
const SKIP_BLOCKS = new Set(['heading', 'codeBlock', 'rawBlock'])
const SKIP_MARKS = new Set(['code', 'link'])

function decorate(doc: PMNode) {
  const out: Decoration[] = []
  doc.descendants((node, pos) => {
    if (SKIP_BLOCKS.has(node.type.name)) return false
    if (!node.isTextblock) return true
    let text = ''
    node.forEach((child) => {
      if (child.isText) text += child.marks.some((m) => SKIP_MARKS.has(m.type.name)) ? ' '.repeat(child.text!.length) : child.text!
      else text += '￼'.repeat(child.nodeSize) // an inline node: a stand-in that keeps positions
    })
    for (const t of tagsInText(text)) out.push(Decoration.inline(pos + 1 + t.from, pos + 1 + t.to, { class: 'pm-tag', 'data-tag': t.tag }))
    return false
  })
  return DecorationSet.create(doc, out)
}

export const tagsKey = new PluginKey<DecorationSet>('tags')

export function tagsPlugin() {
  return new Plugin<DecorationSet>({
    key: tagsKey,
    state: {
      init: (_, state) => decorate(state.doc),
      apply: (tr, set) => (tr.docChanged ? decorate(tr.doc) : set),
    },
    props: {
      decorations: (state) => tagsKey.getState(state),
    },
  })
}
