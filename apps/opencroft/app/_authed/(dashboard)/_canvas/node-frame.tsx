'use client'

import { useEdges as useConnections, useInternalNode, useNodeId } from '@xyflow/react'
import type { LucideIcon } from 'lucide-react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { NodeFrame as KitNodeFrame, type NodeStatus } from 'ui/nodes/node-frame'

import { inspectorIntent } from '@/app/_authed/(dashboard)/_canvas/inspector-intent'
import { NODE_ERRORS_TAB } from '@/app/_authed/(dashboard)/_canvas/node-errors-tab'
import { type HandleRole, staleHandleIds } from '@/app/_authed/(dashboard)/_canvas/stale-handles'
import { NodeDragArea } from '@/app/_authed/(dashboard)/_canvas/touch-move-mode'
import { useNodeErrors } from '@/app/_authed/(dashboard)/_canvas/use-node-errors'
import { InputHandle, OutputHandle } from '@/app/_authed/(extension-runtime)/_client/host'

const NodeAccentContext = createContext<string>('var(--muted-foreground)')

export function NodeAccentProvider({ accent, children }: { accent: string; children: ReactNode }) {
  return <NodeAccentContext.Provider value={accent}>{children}</NodeAccentContext.Provider>
}

export function useNodeAccent(): string {
  return useContext(NodeAccentContext)
}

interface StaleHandle {
  id: string
  role: HandleRole
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

function useStaleHandles(role: HandleRole): StaleHandle[] {
  const nodeId = useNodeId()
  const internal = useInternalNode(nodeId ?? '')
  const connections = useConnections()
  const errorCtx = useContext(ErrorHandleIdsContext)
  return useMemo(
    () =>
      staleHandleIds(internal?.internals?.handleBounds, role, connections, nodeId, errorCtx?.ids ?? new Set()).map(
        (id) => ({ id, role }),
      ),
    [nodeId, internal, connections, role, errorCtx],
  )
}

function StaleHandleLabel({ id }: { id: string }) {
  return (
    <span
      className='text-[10px] font-mono text-destructive truncate max-w-[120px]'
      title={`Stale handle "${id}" — double-click handle to remove the connection`}
    >
      {id}
    </span>
  )
}

function StaleErrorHandle({ id, side }: { id: string; side: StaleHandle['role'] }) {
  const ctx = useContext(ErrorHandleIdsContext)
  const add = ctx?.add
  const remove = ctx?.remove
  useEffect(() => {
    if (!add || !remove) {
      return undefined
    }
    const key = `${side}:${id}`
    add(key)
    return () => remove(key)
  }, [add, remove, side, id])
  if (side === 'source') {
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
          <StaleErrorHandle key={`t:${s.id}`} id={s.id} side='target' />
        ))}
      </div>
      <div className='flex flex-col gap-1 flex-1 min-w-0 items-end'>
        {sources.map((s) => (
          <StaleErrorHandle key={`s:${s.id}`} id={s.id} side='source' />
        ))}
      </div>
    </div>
  )
}

interface NodeFrameProps {
  icon: LucideIcon
  title: string
  subtitle?: string
  status?: NodeStatus
  extra?: ReactNode
  selected: boolean
  loading?: boolean
  /**
   * @deprecated Ignored. The frame reads the node's errors itself: those
   * stored on the node and those its type's `errors` derives.
   */
  errors?: unknown
  input?: ReactNode
  output?: ReactNode
  children?: ReactNode
}

// What is NOT here is as deliberate as what is. The canvas keeps the accent
// context, the connection handles, the stale-handle detection and the node's
// errors, because each of those reads live graph state -- and the kit's own
// NodeFrame cannot depend on a graph to render, since that is exactly what
// makes it usable in a preview. They arrive as props and a footer slot instead.
export function NodeFrame(props: NodeFrameProps) {
  return (
    <ErrorHandleIdsProvider>
      <NodeFrameInner {...props} />
    </ErrorHandleIdsProvider>
  )
}

function NodeFrameInner({ children, errors: _ignored, ...props }: NodeFrameProps) {
  const accent = useNodeAccent()
  const nodeId = useNodeId()
  const node = useInternalNode(nodeId ?? '')
  const errors = useNodeErrors(node ? { id: node.id, type: node.type, data: node.data } : null)
  const showErrors = useCallback(() => {
    if (nodeId) {
      inspectorIntent.open(nodeId, NODE_ERRORS_TAB)
    }
  }, [nodeId])
  return (
    <KitNodeFrame
      {...props}
      accent={accent}
      error={errors.length > 0}
      onShowErrors={showErrors}
      showErrorsClassName='nodrag nopan'
      dragArea={<NodeDragArea />}
      footer={<StaleHandlesBody />}
    >
      {children}
    </KitNodeFrame>
  )
}
