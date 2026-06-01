'use client'

import { useEdges as useConnections, useInternalNode, useNodeId } from '@xyflow/react'
import { AlertTriangle, Copy, type LucideIcon } from 'lucide-react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { NodeCard, NodeCardContent, NodeCardHeader } from '@/app/(dashboard)/_canvas/node-card'
import { InputHandle, OutputHandle } from '@/app/(extension-runtime)/_client/host'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { StatusVariant as IndicatorVariant } from '@/components/ui/utils/status-indicator'

type StatusVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral'

const STATUS_MAP: Record<StatusVariant, IndicatorVariant | undefined> = {
  success: 'success',
  warning: 'warning',
  error: 'destructive',
  info: 'primary',
  neutral: undefined,
}

const NodeAccentContext = createContext<string>('var(--muted-foreground)')

export function NodeAccentProvider({ accent, children }: { accent: string; children: ReactNode }) {
  return <NodeAccentContext.Provider value={accent}>{children}</NodeAccentContext.Provider>
}

export function useNodeAccent(): string {
  return useContext(NodeAccentContext)
}

interface StaleHandle {
  id: string
  role: 'source' | 'target'
}

interface ErrorHandleIdsContextValue {
  ids: ReadonlySet<string>
  add: (key: string) => void
  remove: (key: string) => void
}

const ErrorHandleIdsContext = createContext<ErrorHandleIdsContextValue | null>(null)

function ErrorHandleIdsProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<Set<string>>(() => new Set())
  const add = useCallback((key: string) => {
    setIds((prev) => {
      if (prev.has(key)) {
        return prev
      }
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }, [])
  const remove = useCallback((key: string) => {
    setIds((prev) => {
      if (!prev.has(key)) {
        return prev
      }
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])
  const value = useMemo(() => ({ ids, add, remove }), [ids, add, remove])
  return <ErrorHandleIdsContext.Provider value={value}>{children}</ErrorHandleIdsContext.Provider>
}

function useStaleHandles(role: 'source' | 'target'): StaleHandle[] {
  const nodeId = useNodeId()
  const internal = useInternalNode(nodeId ?? '')
  const connections = useConnections()
  const errorCtx = useContext(ErrorHandleIdsContext)
  return useMemo(() => {
    if (!nodeId) {
      return []
    }
    const handles = internal?.internals?.handleBounds?.[role]
    if (!handles) {
      return []
    }
    const registered = new Set<string>()
    const errorIds = errorCtx?.ids ?? new Set<string>()
    for (const h of handles) {
      if (!h.id) {
        continue
      }
      if (errorIds.has(`${role}:${h.id}`)) {
        continue
      }
      registered.add(h.id)
    }
    const seen = new Set<string>()
    const result: StaleHandle[] = []
    for (const conn of connections) {
      const handleId = role === 'source' ? conn.sourceHandle : conn.targetHandle
      const matchesNode = role === 'source' ? conn.source === nodeId : conn.target === nodeId
      if (!matchesNode || !handleId) {
        continue
      }
      if (seen.has(handleId)) {
        continue
      }
      seen.add(handleId)
      if (!registered.has(handleId)) {
        result.push({ id: handleId, role })
      }
    }
    return result
  }, [nodeId, internal, connections, role, errorCtx])
}

function StaleHandleLabel({ id }: { id: string }) {
  return (
    <span className='text-[10px] font-mono text-destructive truncate max-w-[120px]' title={`Stale handle "${id}" — double-click handle to remove the connection`}>
      {id}
    </span>
  )
}

function StaleErrorHandle({ id, role }: StaleHandle) {
  const ctx = useContext(ErrorHandleIdsContext)
  const add = ctx?.add
  const remove = ctx?.remove
  useEffect(() => {
    if (!add || !remove) {
      return undefined
    }
    const key = `${role}:${id}`
    add(key)
    return () => remove(key)
  }, [add, remove, role, id])
  if (role === 'source') {
    return (
      <OutputHandle type='terminal-context' id={id} color='var(--destructive)'>
        <StaleHandleLabel id={id} />
      </OutputHandle>
    )
  }
  return (
    <InputHandle type='terminal-context' id={id} color='var(--destructive)'>
      <StaleHandleLabel id={id} />
    </InputHandle>
  )
}

function StaleHandlesBody() {
  const sources = useStaleHandles('source')
  const targets = useStaleHandles('target')
  if (sources.length === 0 && targets.length === 0) {
    return null
  }
  return (
    <div className='flex gap-3 px-4 pb-3'>
      <div className='flex flex-col gap-1.5 shrink-0'>
        {targets.map((s) => (
          <StaleErrorHandle key={`t:${s.id}`} id={s.id} role='target' />
        ))}
      </div>
      <div className='flex flex-col gap-1 flex-1 min-w-0 items-end'>
        {sources.map((s) => (
          <StaleErrorHandle key={`s:${s.id}`} id={s.id} role='source' />
        ))}
      </div>
    </div>
  )
}

interface NodeFrameProps {
  icon: LucideIcon
  title: string
  subtitle?: string
  status?: StatusVariant
  extra?: ReactNode
  selected: boolean
  loading?: boolean
  errors?: string[]
  input?: ReactNode
  output?: ReactNode
  children?: ReactNode
}

function copyToClipboard(message: string) {
  navigator.clipboard.writeText(message)
  toast.success('Copied error to clipboard')
}

function NodeErrorTooltip({ errors, children }: { errors: string[]; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>{children}</div>
        </TooltipTrigger>
        <TooltipContent side='top' className='nodrag nopan max-w-sm bg-destructive text-destructive-foreground p-2 pointer-events-auto select-text'>
          <div className='flex flex-col gap-1'>
            {errors.map((msg, i) => (
              <div key={i} className='flex items-start gap-2'>
                <span className='text-xs whitespace-pre-wrap break-words flex-1 font-mono'>{msg}</span>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-5 w-5 shrink-0 text-destructive-foreground hover:bg-destructive-foreground/20 hover:text-destructive-foreground'
                  onClick={() => copyToClipboard(msg)}
                >
                  <Copy className='h-3 w-3' />
                </Button>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function NodeFrame(props: NodeFrameProps) {
  return (
    <ErrorHandleIdsProvider>
      <NodeFrameInner {...props} />
    </ErrorHandleIdsProvider>
  )
}

function NodeFrameInner({ icon, title, subtitle, status, extra, selected, loading, errors, input, output, children }: NodeFrameProps) {
  const accent = useContext(NodeAccentContext)
  const hasErrors = !!errors && errors.length > 0
  const displayIcon = hasErrors ? AlertTriangle : icon
  const iconClassName = hasErrors ? 'text-destructive' : undefined
  const titleClassName = hasErrors ? 'text-destructive' : undefined

  const card = (
    <NodeCard selected={selected} loading={loading} accent={accent} error={hasErrors}>
      <NodeCardHeader
        icon={displayIcon}
        iconClassName={iconClassName}
        title={title}
        titleClassName={titleClassName}
        subtitle={subtitle}
        status={status ? STATUS_MAP[status] : undefined}
        extra={extra}
        input={input}
        output={output}
      />
      {children && <NodeCardContent>{children}</NodeCardContent>}
      <StaleHandlesBody />
    </NodeCard>
  )

  if (!hasErrors) {
    return card
  }
  return <NodeErrorTooltip errors={errors}>{card}</NodeErrorTooltip>
}
