import { useEffect, useRef, useState } from 'react'
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import { helpLevel, type Level } from './caret.ts'
import { helpMod } from './help.ts'

/** The file as Markdown, for anyone who wants to see or edit it as written. */
const spelling = (on: boolean) => EditorView.contentAttributes.of({ spellcheck: on ? 'true' : 'false' })

// Keys that move focus or only modify another key: they leave the notice where it is, so Tab can reach Switch.
const KEEPS_NOTICE = new Set(['Tab', 'Shift', 'Alt', 'Meta', 'Control', 'CapsLock'])

export function SourceEditor({ initial, onChange, onPageView, spellcheck = true }: { initial: string; onChange: (text: string) => void; onPageView?: () => void; spellcheck?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const spell = useRef(new Compartment())
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  const pageViewRef = useRef(onPageView)
  pageViewRef.current = onPageView
  // Help needs the page's structure, so here a help key only says where it works, and offers to switch.
  const [notice, setNotice] = useState<{ left: number; top: number; level: Level } | null>(null)
  const noticeRef = useRef(notice)
  noticeRef.current = notice
  useEffect(() => {
    const show = (level: Level) => {
      const view = viewRef.current
      const at = view?.coordsAtPos(view.state.selection.main.head)
      const box = host.current?.getBoundingClientRect()
      setNotice({ left: at?.left ?? box?.left ?? 0, top: (at?.bottom ?? box?.top ?? 0) + 8, level })
    }
    // The same help key again, with the notice showing, switches: the keyboard's way to the page view.
    const ask = (level: Level) => {
      if (noticeRef.current && pageViewRef.current) return pageViewRef.current()
      show(level)
    }
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
          EditorView.contentAttributes.of({ 'aria-label': 'Document as Markdown' }),
          spell.current.of(spelling(spellcheck)),
          EditorView.updateListener.of((u) => u.docChanged && changeRef.current(u.state.doc.toString())),
          EditorView.domEventHandlers({
            keydown: (e) => {
              const level = helpLevel(e)
              if (level) {
                e.preventDefault()
                ask(level)
                return true
              }
              if (!noticeRef.current || KEEPS_NOTICE.has(e.key)) return false
              setNotice(null)
              // Esc only closes the notice; any other key goes on to the text as usual.
              if (e.key === 'Escape') {
                e.preventDefault()
                return true
              }
              return false
            },
            mousedown: () => setNotice(null),
          }),
        ],
      }),
    })
    viewRef.current = view
    view.focus()
    // A help key pressed in the title while this view is open.
    const fromTitle = (e: Event) => {
      view.focus()
      ask((e as CustomEvent<{ level: Level }>).detail?.level ?? 1)
    }
    // Restoring a version: one change, so ⌘Z brings back what was there.
    const replaceBody = (e: Event) =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: (e as CustomEvent<{ body: string }>).detail.body },
        selection: { anchor: 0 },
        scrollIntoView: true,
        annotations: isolateHistory.of('full'),
      })
    window.addEventListener('ekdanta:help', fromTitle)
    window.addEventListener('ekdanta:replace-body', replaceBody)
    return () => {
      window.removeEventListener('ekdanta:help', fromTitle)
      window.removeEventListener('ekdanta:replace-body', replaceBody)
      viewRef.current = null
      view.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    viewRef.current?.dispatch({ effects: spell.current.reconfigure(spelling(spellcheck)) })
  }, [spellcheck])
  return (
    <>
      <div className="editor source-editor" ref={host} />
      {notice && (
        <div
          className="source-help hl-line hl-notice"
          role="status"
          style={{ left: notice.left, top: notice.top }}
          onKeyDown={(e) => {
            // Esc from the Switch button: close the notice and go back to the text.
            if (e.key !== 'Escape') return
            e.preventDefault()
            setNotice(null)
            viewRef.current?.focus()
          }}
        >
          <span className="hl-text">Help works in the page view</span>
          {onPageView && (
            <>
              <span className="hl-sep">·</span>
              <button className="hl-link" onMouseDown={(e) => e.preventDefault()} onClick={() => onPageView()}>
                Switch
              </button>
              <span className="source-help-key">
                or {helpMod}
                {notice.level} again
              </span>
            </>
          )}
        </div>
      )}
    </>
  )
}
