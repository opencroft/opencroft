'use client'

import { json } from '@codemirror/lang-json'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, lineNumbers } from '@codemirror/view'
import { Button } from 'ui/button'
import CodeMirror from '@uiw/react-codemirror'
import { Columns2, Rows2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

type DiffMode = 'unified' | 'split'

interface NodeDiffEditorProps {
  current: string
  next: string
}

function UnifiedDiff({ current, next }: { current: string; next: string }) {
  const { resolvedTheme } = useTheme()
  const extensions = useMemo(() => [json(), unifiedMergeView({ original: current, mergeControls: false, highlightChanges: true }), EditorView.editable.of(false)], [current])

  return (
    <CodeMirror
      value={next}
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      extensions={extensions}
      editable={false}
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
    />
  )
}

function SplitDiff({ current, next }: { current: string; next: string }) {
  const { resolvedTheme } = useTheme()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    const themeExt = resolvedTheme === 'dark' ? [oneDark] : []
    const baseExtensions = [lineNumbers(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), json(), EditorView.editable.of(false), ...themeExt]
    const view = new MergeView({
      parent: host,
      a: { doc: current, extensions: baseExtensions },
      b: { doc: next, extensions: baseExtensions },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    })
    return () => view.destroy()
  }, [current, next, resolvedTheme])

  return <div ref={hostRef} />
}

function ModeToggle({ mode, onChange }: { mode: DiffMode; onChange: (mode: DiffMode) => void }) {
  return (
    <div className='flex gap-0.5 rounded-md border p-0.5'>
      <Button variant='ghost' size='icon' className={cn('h-6 w-6', mode === 'unified' && 'bg-accent')} onClick={() => onChange('unified')} title='Unified'>
        <Rows2 className='h-3 w-3' />
      </Button>
      <Button variant='ghost' size='icon' className={cn('h-6 w-6', mode === 'split' && 'bg-accent')} onClick={() => onChange('split')} title='Side by side'>
        <Columns2 className='h-3 w-3' />
      </Button>
    </div>
  )
}

export function NodeDiffEditor({ current, next }: NodeDiffEditorProps) {
  const [mode, setMode] = useState<DiffMode>('split')

  return (
    <div className='space-y-1.5'>
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
      <div className='flex justify-end'>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>
      <div className='rounded-md border overflow-auto text-xs'>{mode === 'unified' ? <UnifiedDiff current={current} next={next} /> : <SplitDiff current={current} next={next} />}</div>
    </div>
  )
}
