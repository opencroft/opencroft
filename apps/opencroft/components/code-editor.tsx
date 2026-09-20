'use client'

import { type DiffOnMount, Editor, loader, DiffEditor as MonacoDiffEditor, type OnMount } from '@monaco-editor/react'
import { Columns2, Rows2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from 'ui/button'

import { cn } from '@/lib/utils'

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
// The same argument is why diffs are a mode of this component rather than a
// second one: a diff is the same editor runtime with a second model, and every
// surface that shows one should reach it through here.
//
// Monaco's runtime is fetched by @monaco-editor/loader, which defaults to a
// public CDN. To serve it from this origin instead, call `loader.config()` once
// during app start-up — re-exported here so there is one place to do it.
export { loader }

export type CodeEditorLanguage = 'typescript' | 'javascript' | 'python' | 'shell' | 'json' | 'plaintext'

export interface CodeEditorProps {
  /** In diff mode (`original` given) this is the modified side. */
  value: string
  /**
   * The unchanged side of a diff. Given -> this renders a diff; omitted -> an
   * ordinary editor.
   *
   * Note that the two modes are two different components underneath
   * (@monaco-editor/react's `Editor` and `DiffEditor`), so flipping `original`
   * between undefined and defined remounts the editor and drops its undo
   * history. That is acceptable for the intended use — a file does not turn
   * into a diff mid-edit — but nothing in the type says so, so it is said here.
   */
  original?: string
  language?: CodeEditorLanguage
  /** Applies to the editable side only; `original` is always read-only. */
  readOnly?: boolean
  onChange?: (value: string) => void
  /** Reveal and place the cursor on this 1-based line once, on mount. */
  line?: number
  /**
   * Defaults to filling its container, which must have a definite height — in
   * diff mode it instead defaults to the content's own height, bounded (see
   * MIN_HEIGHT / MAX_HEIGHT), because diffs render inline in a chat transcript.
   */
  height?: string | number
}

export function CodeEditor({ original, ...props }: CodeEditorProps) {
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
    //
    // Diff mode is `relative` for the overlaid mode toggle, and `min-w-0
    // max-w-full` guard the cases where this box is a flex item or has a
    // definite containing block.
    <div className={cn('nokey', original === undefined ? 'h-full w-full' : 'relative min-w-0 max-w-full')}>
      {original === undefined ? <PlainEditor {...props} /> : <DiffView {...props} original={original} />}
    </div>
  )
}

function PlainEditor({
  value,
  language = 'typescript',
  readOnly,
  onChange,
  line,
  height = '100%',
}: Omit<CodeEditorProps, 'original'>) {
  const { resolvedTheme } = useTheme()

  const handleMount: OnMount | undefined = line
    ? (editor) => {
        editor.revealLineInCenter(line)
        editor.setPosition({ lineNumber: line, column: 1 })
      }
    : undefined

  return (
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
  )
}

type DiffMode = 'unified' | 'split'

// Diffs render inline in a chat transcript, so the editor is sized to its
// content rather than given a fixed box. The floor keeps a one-line diff from
// collapsing under its own toolbar; the ceiling stops a thousand-line diff from
// swallowing the transcript, and hands the rest to Monaco's own scroller.
// (Carried over from the chat package's diff editor, which these diffs used to
// be rendered by; a caller that wants a fixed box passes `height`.)
const MIN_HEIGHT = 56
const MAX_HEIGHT = 400

function ModeToggle({ mode, onChange }: { mode: DiffMode; onChange: (mode: DiffMode) => void }) {
  return (
    <div className='flex gap-0.5 rounded-md border bg-background/90 p-0.5 shadow-sm backdrop-blur-sm'>
      <Button
        variant='ghost'
        size='icon'
        className={cn('h-6 w-6', mode === 'unified' && 'bg-accent')}
        onClick={() => onChange('unified')}
        title='Unified'
      >
        <Rows2 className='h-3 w-3' />
      </Button>
      <Button
        variant='ghost'
        size='icon'
        className={cn('h-6 w-6', mode === 'split' && 'bg-accent')}
        onClick={() => onChange('split')}
        title='Side by side'
      >
        <Columns2 className='h-3 w-3' />
      </Button>
    </div>
  )
}

function DiffView({
  value,
  original,
  language = 'typescript',
  readOnly,
  onChange,
  line,
  height,
}: Omit<CodeEditorProps, 'original'> & { original: string }) {
  // The chat package's diff editor tracked dark mode itself, watching <html>
  // for the `dark` class with a MutationObserver — it has to, being usable by
  // any host regardless of how that host switches themes. Here we are the host:
  // `next-themes` is the signal the rest of the app already reads, it is
  // mounted above every mount of this component, and it costs no observer per
  // visible diff. Same rule as the ordinary editor above, so the two modes
  // cannot disagree about the theme.
  const { resolvedTheme } = useTheme()

  // Unified by default. Side by side splits an already narrow column in two and
  // is unreadable on a phone even when it fits; the toggle keeps it one press
  // away. Deliberately unconditional rather than chosen from the viewport — a
  // default that flips under a resize is state to reason about, and nothing
  // here needs it. Internal state, not a prop: which of two renderings of the
  // same pair of documents you are looking at is the reader's business, and no
  // caller has an opinion worth honouring.
  const [mode, setMode] = useState<DiffMode>('unified')
  const [contentHeight, setContentHeight] = useState(MIN_HEIGHT)

  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null)
  const disposablesRef = useRef<{ dispose: () => void }[]>([])
  // Read through a ref so the content-size subscriptions below stay valid
  // across a mode change. Switching mode only updates Monaco's options, it
  // doesn't remount the editor, so a listener that closed over `mode` would go
  // on measuring for the mode it was registered in. (Kept in step by the effect
  // below rather than during render, so that the re-measure it has to do anyway
  // is the same piece of work.)
  const modeRef = useRef<DiffMode>(mode)
  // Same reason, for the change subscription: it is registered once on mount
  // and must see the current props, not the ones it was created with.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const valueRef = useRef(value)
  valueRef.current = value

  const syncHeight = useCallback(() => {
    const editor = editorRef.current
    if (!editor) {
      return
    }
    const modified = editor.getModifiedEditor().getContentHeight()
    // Side by side is as tall as its taller pane. Inline renders the removed
    // lines inside the modified editor as view zones, so that one already
    // accounts for both sides and taking the max would overshoot.
    const tallest =
      modeRef.current === 'split' ? Math.max(modified, editor.getOriginalEditor().getContentHeight()) : modified
    setContentHeight(Math.min(Math.max(tallest, MIN_HEIGHT), MAX_HEIGHT))
  }, [])

  const handleMount = useCallback<DiffOnMount>(
    (editor) => {
      editorRef.current = editor
      const modified = editor.getModifiedEditor()
      disposablesRef.current = [
        editor.getOriginalEditor().onDidContentSizeChange(syncHeight),
        modified.onDidContentSizeChange(syncHeight),
        // `DiffEditor` has no `onChange` prop of its own — the modified model is
        // the only editable half, so the edit event comes off that editor.
        modified.onDidChangeModelContent(() => {
          const next = modified.getValue()
          // A new `value` prop is applied by writing the model, which lands here
          // too; skipping it keeps a controlled caller from being handed back
          // the write it just made.
          if (next !== valueRef.current) {
            onChangeRef.current?.(next)
          }
        }),
      ]
      if (line) {
        modified.revealLineInCenter(line)
        modified.setPosition({ lineNumber: line, column: 1 })
      }
      syncHeight()
    },
    [syncHeight, line],
  )

  // Point the listeners at the new mode and re-measure: the two layouts have
  // different heights for the same pair of documents, and toggling doesn't
  // itself change content size, so nothing else would reliably fire.
  useEffect(() => {
    modeRef.current = mode
    syncHeight()
  }, [syncHeight, mode])

  useEffect(
    () => () => {
      for (const disposable of disposablesRef.current) {
        disposable.dispose()
      }
      disposablesRef.current = []
      editorRef.current = null
    },
    [],
  )

  return (
    <>
      {/* Overlaid on top of the diff instead of its own row, so it doesn't cost
          a whole line of vertical space. */}
      <div className='absolute right-2 top-2 z-10'>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      {/* `contain: inline-size` makes this box's width computable without
          looking at its contents, so a long line can't propagate outward
          through every ancestor whose width is content-derived and widen the
          whole page — the failure this fixed, measured at 1060px of content
          inside a 360px column on a phone.

          Monaco lays out absolutely inside a box it is told the size of, so it
          is far less likely than the previous CodeMirror implementation to
          inflate an ancestor on its own. The containment is kept anyway: it
          costs nothing, and dropping it would be an unforced bet that the new
          editor never does. Under it this box contributes nothing to intrinsic
          sizing, so it needs a containing block with a definite width — every
          call site gives it one, and a host that doesn't will collapse it to
          zero. */}
      <div className='w-full min-w-0 [contain:inline-size] overflow-hidden rounded-md border'>
        <MonacoDiffEditor
          height={height ?? contentHeight}
          language={language}
          original={original}
          modified={value}
          theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
          onMount={handleMount}
          loading={<div className='h-14 w-full animate-pulse bg-muted' />}
          options={{
            // The modified side follows the same rule as the ordinary editor:
            // no `onChange` means nothing could accept an edit anyway.
            readOnly: Boolean(readOnly) || !onChange,
            // Unlike the ordinary editor this does not also set `domReadOnly`:
            // a diff is read to be read, and taking the element out of the
            // input path would take selection and copy out with it.
            originalEditable: false,
            renderSideBySide: mode === 'split',
            // Monaco traps the wheel by default, which inside a chat transcript
            // means scrolling stalls whenever the pointer crosses a diff.
            scrollbar: { alwaysConsumeMouseWheel: false },
            // Long diffs are mostly untouched context; collapse it the way the
            // previous implementation's `collapseUnchanged` did.
            hideUnchangedRegions: { enabled: true, minimumLineCount: 4, contextLineCount: 3 },
            minimap: { enabled: false },
            overviewRulerLanes: 0,
            scrollBeyondLastLine: false,
            lineNumbers: 'on',
            folding: false,
            contextmenu: false,
            fontSize: 12,
            // The container's width is set by the surrounding layout and changes
            // without a React render (sidebar, rotation), so Monaco has to
            // observe it rather than be told.
            automaticLayout: true,
          }}
        />
      </div>
    </>
  )
}
