'use client'

import { type DiffOnMount, loader, DiffEditor as MonacoDiffEditor } from '@monaco-editor/react'
import { cn } from 'cn'
import { Columns2, Rows2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from 'ui/components/ui/button'

// A separate subpath export (`agent-chat/diff-editor`), never imported from the
// core chat modules — Monaco is a heavy dependency and hosts that don't register
// a diff-showing tool view shouldn't pay for it.
//
// Monaco's runtime is fetched by @monaco-editor/loader, which by default pulls
// it from a public CDN. That is why nothing here configures a bundler or a web
// worker: this package stays host-agnostic precisely because it never touches
// either. A host that must run offline, or that would rather not have a third
// party in this load path, re-points the loader once before first render:
//
//   import { loader } from 'agent-chat/diff-editor'
//   import * as monaco from 'monaco-editor'
//   loader.config({ monaco })                       // from the host's own bundle
//   loader.config({ paths: { vs: '/monaco/vs' } })  // or from the host's origin
//
// Re-exported rather than decided here: where the bytes come from is a bundling
// and deployment question, and those belong to the host.
export { loader }

type DiffMode = 'unified' | 'split'

export interface DiffEditorProps {
  current: string
  next: string
}

// These diffs render inline in a chat transcript, so the editor is sized to its
// content rather than given a fixed box. The floor keeps a one-line diff from
// collapsing under its own toolbar; the ceiling stops a thousand-line diff from
// swallowing the transcript, and hands the rest to Monaco's own scroller.
const MIN_HEIGHT = 56
const MAX_HEIGHT = 400

// Tracks the shadcn dark-mode convention (a `dark` class on <html>) via a
// MutationObserver, rather than depending on a theming library — this stays
// usable by any host regardless of how it wires up theme switching.
function useIsDarkMode(): boolean {
  // Guarded because this initializer runs during render, which on a
  // server-rendered host means it runs where there is no `document` — and the
  // failure is the whole route dying, not a diff without its colours. Starting
  // light and correcting in the effect below costs one client-side update.
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')))
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

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

// A two-mode (unified/split) read-only JSON diff viewer, built on Monaco's diff
// editor. Register it (or wrap it) inside a `ToolViewSpec.component` for any
// tool whose args/result are worth diffing — e.g. before/after a node or file
// edit.
export function DiffEditor({ current, next }: DiffEditorProps) {
  // Unified by default. Side by side splits an already narrow column in two and
  // is unreadable on a phone even when it fits; the toggle keeps it one press
  // away. Deliberately unconditional rather than chosen from the viewport — a
  // default that flips under a resize is state to reason about, and nothing
  // here needs it.
  const [mode, setMode] = useState<DiffMode>('unified')
  const [height, setHeight] = useState(MIN_HEIGHT)

  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null)
  const disposablesRef = useRef<{ dispose: () => void }[]>([])
  // Read through a ref so the content-size subscriptions below stay valid
  // across a mode change. Switching mode only updates Monaco's options, it
  // doesn't remount the editor, so a listener that closed over `mode` would go
  // on measuring for the mode it was registered in.
  const modeRef = useRef<DiffMode>(mode)
  modeRef.current = mode

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
    setHeight(Math.min(Math.max(tallest, MIN_HEIGHT), MAX_HEIGHT))
  }, [])

  const handleMount = useCallback<DiffOnMount>(
    (editor) => {
      editorRef.current = editor
      disposablesRef.current = [
        editor.getOriginalEditor().onDidContentSizeChange(syncHeight),
        editor.getModifiedEditor().onDidContentSizeChange(syncHeight),
      ]
      syncHeight()
    },
    [syncHeight],
  )

  // Re-measure when the mode changes: the two layouts have different heights
  // for the same pair of documents, and toggling doesn't itself change content
  // size, so nothing else would fire.
  useEffect(() => {
    syncHeight()
  }, [syncHeight])

  useEffect(
    () => () => {
      for (const disposable of disposablesRef.current) {
        disposable.dispose()
      }
      disposablesRef.current = []
      // @monaco-editor/react 4.7 disposes the models before the editor that
      // still shows them, which Monaco 0.55 answers with "TextModel got disposed
      // before DiffEditorWidget model got reset". So the models are kept out of
      // its hands (`keepCurrent*Model` below) and released here instead —
      // detached first. This runs before the library's own unmount cleanup,
      // since React runs a parent's cleanups before its children's.
      const editor = editorRef.current
      const models = editor?.getModel()
      editor?.setModel(null)
      models?.original.dispose()
      models?.modified.dispose()
      editorRef.current = null
    },
    [],
  )

  const dark = useIsDarkMode()

  return (
    // `min-w-0` and `max-w-full` guard the cases where this box is a flex item
    // or has a definite containing block.
    <div className='relative min-w-0 max-w-full'>
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
          height={height}
          language='json'
          original={current}
          modified={next}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          theme={dark ? 'vs-dark' : 'vs'}
          onMount={handleMount}
          loading={<div className='h-14 w-full animate-pulse bg-muted' />}
          options={{
            readOnly: true,
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
            // The container's width is set by the host's layout and changes
            // without a React render (sidebar, rotation), so Monaco has to
            // observe it rather than be told.
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  )
}
