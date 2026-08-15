'use client'

import { Editor, loader, type OnMount } from '@monaco-editor/react'
import { useTheme } from 'next-themes'

// The host's single code editor, shared with extensions through the extension
// UI surface (`legacy.CodeEditor`) rather than imported by each extension.
//
// That sharing is not a convenience, it is the correctness requirement. An
// extension's client bundle is a browser ESM bundle with no runtime module
// resolver, so an extension that imported an editor package would get its own
// copy of @monaco-editor/loader. Two loader instances each hold their own
// "initialized" flag and only adopt an existing editor when `window.monaco` is
// already set — so two of them mounting before the first finishes injects the
// AMD loader script twice and races on `window.require`. The compiler already
// redirects `react` to the host's copy for the same class of reason; Monaco
// belongs on the same footing.
//
// Monaco's runtime is fetched by @monaco-editor/loader, which defaults to a
// public CDN. To serve it from this origin instead, call `loader.config()` once
// during app start-up — re-exported here so there is one place to do it.
export { loader }

export type CodeEditorLanguage = 'typescript' | 'javascript' | 'python' | 'shell' | 'json' | 'plaintext'

export interface CodeEditorProps {
  value: string
  language?: CodeEditorLanguage
  readOnly?: boolean
  onChange?: (value: string) => void
  /** Reveal and place the cursor on this 1-based line once, on mount. */
  line?: number
  /** Defaults to filling its container, which must have a definite height. */
  height?: string | number
}

export function CodeEditor({
  value,
  language = 'typescript',
  readOnly,
  onChange,
  line,
  height = '100%',
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme()

  const handleMount: OnMount | undefined = line
    ? (editor) => {
        editor.revealLineInCenter(line)
        editor.setPosition({ lineNumber: line, column: 1 })
      }
    : undefined

  return (
    // `nokey` is @xyflow/react's opt-out: its `useKeyPress` calls
    // `preventDefault()` on any key it watches unless the event came from an
    // "interactive element", and `isInputDOMNode` only recognises INPUT /
    // SELECT / TEXTAREA, `contenteditable`, or a `.nokey` ancestor.
    //
    // Monaco defaults `editContext: true`, so it takes input through the
    // EditContext API on a plain div — none of those. Without this class the
    // canvas swallows Space (its pan-activation key) so it never reaches the
    // editor, and Backspace/Delete reach the canvas as node deletion while the
    // caret is in the editor. The previous CodeMirror editor was a
    // contenteditable div, which is why neither happened before.
    <div className='nokey h-full w-full'>
      <Editor
        height={height}
        language={language}
        value={value}
        theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
        onChange={onChange ? (next) => onChange(next ?? '') : undefined}
        onMount={handleMount}
        loading={<div className='h-full w-full animate-pulse bg-muted' />}
        options={{
          readOnly: Boolean(readOnly) || !onChange,
          // `readOnly` alone still takes focus and shows a caret, which reads as
          // an editable field that silently drops input.
          domReadOnly: Boolean(readOnly) || !onChange,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbers: 'on',
          folding: true,
          tabSize: 2,
          contextmenu: false,
          fontSize: 12,
          // Containers here are sized by the surrounding layout (inspector tabs,
          // resizable panels) and change without a React render, so Monaco has to
          // observe its box rather than be told about it.
          automaticLayout: true,
        }}
      />
    </div>
  )
}
