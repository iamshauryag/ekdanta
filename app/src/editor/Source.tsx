import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
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
    // Restoring a version: one change, so ⌘Z brings back what was there.
    const replaceBody = (e: Event) =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: (e as CustomEvent<{ body: string }>).detail.body },
        selection: { anchor: 0 },
        scrollIntoView: true,
        annotations: isolateHistory.of('full'),
      })
    window.addEventListener('ekdanta:replace-body', replaceBody)
    return () => {
      window.removeEventListener('ekdanta:replace-body', replaceBody)
      view.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div className="editor source-editor" ref={host} />
}
