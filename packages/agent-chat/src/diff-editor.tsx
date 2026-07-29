'use client'

import { json } from '@codemirror/lang-json'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, lineNumbers } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { Columns2, Rows2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'ui/components/ui/button'
import { cn } from 'ui/lib/utils'

// A separate subpath export (`agent-chat/diff-editor`), never imported from
// the core chat modules — CodeMirror is a heavy dependency and hosts that
// don't register a diff-showing tool view shouldn't pay for it.

type DiffMode = 'unified' | 'split'

export interface DiffEditorProps {
  current: string
  next: string
}

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

function UnifiedDiff({ current, next }: { current: string; next: string }) {
  const dark = useIsDarkMode()
  const extensions = useMemo(
    () => [
      json(),
      unifiedMergeView({ original: current, mergeControls: false, highlightChanges: true }),
      EditorView.editable.of(false),
    ],
    [current],
  )

  return (
    <CodeMirror
      value={next}
      theme={dark ? 'dark' : 'light'}
      extensions={extensions}
      editable={false}
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
    />
  )
}

function SplitDiff({ current, next }: { current: string; next: string }) {
  const dark = useIsDarkMode()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    const themeExt = dark ? [oneDark] : []
    const baseExtensions = [
      lineNumbers(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      json(),
      EditorView.editable.of(false),
      ...themeExt,
    ]
    const view = new MergeView({
      parent: host,
      a: { doc: current, extensions: baseExtensions },
      b: { doc: next, extensions: baseExtensions },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    })
    return () => view.destroy()
  }, [current, next, dark])

  return <div ref={hostRef} />
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

// A two-mode (unified/split) read-only JSON diff viewer, built on CodeMirror's
// merge view. Register it (or wrap it) inside a `ToolViewSpec.component` for
// any tool whose args/result are worth diffing — e.g. before/after a node or
// file edit.
export function DiffEditor({ current, next }: DiffEditorProps) {
  // Unified by default. Side by side splits an already narrow column in two and
  // is unreadable on a phone even when it fits; the toggle keeps it one press
  // away. Deliberately unconditional rather than chosen from the viewport — a
  // default that flips under a resize is state to reason about, and nothing
  // here needs it.
  const [mode, setMode] = useState<DiffMode>('unified')

  return (
    // `min-w-0` and `max-w-full` guard the cases where this box is a flex item
    // or has a definite containing block. They are not what stops the diff
    // widening the page — see the scroll box below for that.
    <div className='relative min-w-0 max-w-full'>
      <style>{`
        .cm-merge-a .cm-changedText,
        .cm-deletedChunk .cm-deletedText {
          background: rgba(238, 68, 51, 0.3) !important;
        }
        .cm-merge-b .cm-changedText,
        .cm-insertedLine .cm-changedText {
          background: rgba(34, 187, 34, 0.3) !important;
        }
      `}</style>
      {/* Overlaid on top of the diff instead of its own row, so it doesn't cost
          a whole line of vertical space. */}
      <div className='absolute right-2 top-2 z-10'>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      {/* `contain: inline-size` is what actually bounds the diff, and it is here
          rather than on an ancestor because this is the last box before
          CodeMirror.

          CodeMirror writes the widest line it has seen onto its content tile as
          an inline pixel `flex-basis`. That gives `.cm-scroller` — a flex
          container — a min-content width of the longest line, and that width
          then propagates outward through every ancestor whose own width is
          content-derived, all the way to the document. Measured on a phone: the
          scroller rendered 1060px inside a 360px column, with every ancestor
          above it wider in lockstep and nothing clamping.

          Percentage widths cannot break that: `w-full` resolves against a
          containing block that is itself already inflated. `min-w-0` does not
          either — it removes a flex item's automatic minimum size, and these
          boxes are not flex items. Both were tried and neither was reached.

          Size containment in the inline axis is what does: it makes this box's
          width computable without looking at its contents, so the tile stops
          contributing to anything outside, ancestors resolve against the
          viewport again, and the overflow lands on this box's own scroller —
          where horizontal scrolling already worked.

          Under inline-size containment this box contributes nothing to
          intrinsic sizing, so it requires a containing block with a definite
          width. Every call site here gives it one — a host that doesn't will
          collapse it to zero. */}
      <div className='w-full min-w-0 [contain:inline-size] rounded-md border overflow-auto text-xs'>
        {mode === 'unified' ? (
          <UnifiedDiff current={current} next={next} />
        ) : (
          <SplitDiff current={current} next={next} />
        )}
      </div>
    </div>
  )
}
