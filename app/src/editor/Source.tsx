import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'

/** The file as Markdown, for anyone who wants to see or edit it as written. */
export function SourceEditor({ initial, onChange }: { initial: string; onChange: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(classHighlighter),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Document as Markdown' }),
          EditorView.updateListener.of((u) => u.docChanged && changeRef.current(u.state.doc.toString())),
        ],
      }),
    })
    view.focus()
    return () => view.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div className="editor source-editor" ref={host} />
}
