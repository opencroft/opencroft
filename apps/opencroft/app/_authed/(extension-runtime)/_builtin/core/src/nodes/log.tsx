import { InputHandle, inspectorIntent, NodeFrame, useReactFlow } from '@opencroft/client/canvas'
import { Button } from '@opencroft/client/ui'
import { Copy, ScrollText, Trash2 } from 'lucide-react'
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef } from 'react'

export interface LogEntry {
  at: number
  text: string
}

export interface LogData {
  max: number
  entries: LogEntry[]
}

const DEFAULT_MAX = 500

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function LogNode({ id, data, selected }: { id: string; data: LogData; selected?: boolean }) {
  const { setNodes } = useReactFlow()
  const entries = data.entries ?? []

  const focus = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
  }, [id, setNodes])

  const openOutput = useCallback(() => {
    focus()
    inspectorIntent.open(id, 'details')
  }, [id, focus])

  const subtitle = `${entries.length} entries`

  return (
    <NodeFrame
      icon={ScrollText}
      title='Log'
      subtitle={subtitle}
      selected={selected ?? false}
      input={<InputHandle type='text-stream' id='text-in' />}
      extra={
        <Button
          variant='ghost'
          size='sm'
          className='nodrag nopan h-5 text-[10px] px-1.5'
          onClick={openOutput}
          disabled={entries.length === 0}
        >
          <ScrollText className='h-2.5 w-2.5 shrink-0' />
          <span>Output</span>
        </Button>
      }
    />
  )
}

export function LogInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: LogData
  updateData: (p: Partial<LogData>) => void
}) {
  const entries = data.entries ?? []
  const scrollRef = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: new entries are the trigger to scroll to the end; the effect does not read them
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [entries])

  const copy = useCallback(() => {
    const text = entries.map((e) => `[${formatTime(e.at)}] ${e.text}`).join('\n')
    navigator.clipboard.writeText(text).catch(() => {})
  }, [entries])

  const clear = useCallback(() => {
    updateData({ entries: [] })
  }, [updateData])

  // Entries carry no id and several can share a timestamp, so the key is the timestamp plus the
  // occurrence count of that timestamp; unlike an array index it survives trimming from the front.
  const keyedEntries = useMemo(() => {
    const seen = new Map<number, number>()
    return entries.map((entry) => {
      const occurrence = seen.get(entry.at) ?? 0
      seen.set(entry.at, occurrence + 1)
      return { key: `${entry.at}-${occurrence}`, entry }
    })
  }, [entries])

  return (
    <div className='flex flex-col gap-3'>
      <label className='flex flex-col gap-1 text-xs'>
        <span>Max entries</span>
        <input
          type='number'
          min={1}
          className='h-8 rounded border bg-transparent px-2 text-xs'
          value={data.max ?? DEFAULT_MAX}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ max: Number(e.target.value) || DEFAULT_MAX })}
        />
      </label>
      <div className='flex flex-col gap-1'>
        <div className='flex items-center justify-between'>
          <span className='text-xs'>Output</span>
          <div className='flex items-center gap-1'>
            <Button variant='ghost' size='sm' onClick={copy} disabled={entries.length === 0}>
              <Copy className='h-3 w-3 mr-1' /> Copy
            </Button>
            <Button variant='ghost' size='sm' onClick={clear} disabled={entries.length === 0}>
              <Trash2 className='h-3 w-3 mr-1' /> Clear
            </Button>
          </div>
        </div>
        <div ref={scrollRef} className='bg-black p-2 rounded-md overflow-auto max-h-[280px]'>
          {entries.length === 0 ? (
            <p className='text-[10px] text-muted-foreground italic'>No log entries yet.</p>
          ) : (
            <div className='font-mono text-[11px] text-[#cccccc] flex flex-col gap-1'>
              {keyedEntries.map(({ key, entry: e }) => (
                <div key={key} className='whitespace-pre-wrap break-words'>
                  <span className='text-muted-foreground'>[{formatTime(e.at)}]</span> <span>{e.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const LOG_HANDLES = [{ id: 'text-in', handleType: 'text-stream', role: 'target' as const, label: 'Text' }]
