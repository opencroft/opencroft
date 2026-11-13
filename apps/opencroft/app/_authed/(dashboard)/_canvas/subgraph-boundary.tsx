'use client'

import { STRING_TYPE } from '@opencroft/core/values'
import { type NodeProps, useReactFlow, useUpdateNodeInternals } from '@xyflow/react'
import { ListChecks, LogIn, LogOut } from 'lucide-react'
import { createContext, memo, useContext, useEffect, useState } from 'react'
import { Button } from 'ui/button'
import { inRowOrder, NodeRowList } from 'ui/nodes/node-row-list'

import { NodeFrame } from '@/app/_authed/(dashboard)/_canvas/node-frame'
import { type BoundaryData, NEW_PORT_HANDLE } from '@/app/_authed/(dashboard)/_canvas/subgraph-level'
import {
  type PortSide,
  portHandleId,
  portsOf,
  type SubgraphData,
  type SubgraphPort,
  withPortOptions,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { InputHandle, OutputHandle } from '@/app/_authed/(extension-runtime)/_client/host'

/**
 * Writes a subgraph's whole data, as its boundaries change its ports: each
 * write its own undo step, a removed port's edges going with it. The canvas
 * provides it.
 */
export const SubgraphDataWriterContext = createContext<
  ((subgraphId: string, data: Record<string, unknown>) => void) | null
>(null)

/** Whether a port on `side` takes choices: a text input. */
function takesChoices(side: PortSide, port: SubgraphPort): boolean {
  return side === 'inputs' && port.handleType === STRING_TYPE
}

// One side of an open subgraph's ports, drawn on its canvas: Inputs hands each
// input port on to the nodes inside, Outputs takes each output port from them.
// Each port is a row of the kit's Node Row List beside its pin: dragged to
// another place, renamed or deleted from its menu. A text input's choices open
// under its row, as rows of the same list. The last handle is the empty slot:
// an edge connected to it makes a new port (see `addPort`).
export const SubgraphBoundary = memo(function SubgraphBoundary({ id, data }: NodeProps) {
  const { subgraphId, side, ports } = data as BoundaryData
  const updateNodeInternals = useUpdateNodeInternals()
  const write = useContext(SubgraphDataWriterContext)
  const { getNode } = useReactFlow()
  const [openChoices, setOpenChoices] = useState<string | null>(null)
  const handleKey = ports.map((p) => p.id).join(',')

  // Handles come and go with the ports; React Flow has to re-measure the node
  // to know where the new ones are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleKey is only a re-run trigger, the effect does not read it
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, handleKey, updateNodeInternals])

  // Each change starts from the subgraph's data as it is now, so it keeps
  // what the other side and the values on the card hold.
  const change = (next: (data: SubgraphData) => SubgraphData) => {
    const current = getNode(subgraphId)?.data
    if (current && write) {
      write(subgraphId, next(current as unknown as SubgraphData) as unknown as Record<string, unknown>)
    }
  }
  const setPorts = (list: (now: SubgraphPort[]) => SubgraphPort[]) =>
    change((now) => ({ ...now, ports: { ...portsOf(now), [side]: list(portsOf(now)[side]) } }))
  const setChoices = (portId: string, list: (now: { value: string; label?: string }[]) => typeof now) =>
    change((now) => {
      const port = portsOf(now)[side].find((p) => p.id === portId)
      return port ? withPortOptions(now, portId, list(port.options ?? [])) : now
    })

  const inputs = side === 'inputs'
  const Pin = inputs ? OutputHandle : InputHandle
  const portOf = new Map(ports.map((p) => [p.id, p]))
  return (
    <NodeFrame icon={inputs ? LogIn : LogOut} title={inputs ? 'Inputs' : 'Outputs'} selected={false}>
      {/* A wider minimum needs `BOUNDARY_WIDTH` raised to match, or a new Inputs stands nearer the contents than `BOUNDARY_GAP`. */}
      <div className='flex min-w-56 flex-col gap-0.5'>
        <NodeRowList
          label={inputs ? 'Inputs' : 'Outputs'}
          rows={ports.map((p) => ({ id: p.id, label: p.label }))}
          onReorder={(ids) => setPorts((now) => inRowOrder(now, (p) => p.id, ids))}
          onRename={(portId, label) => setPorts((now) => now.map((p) => (p.id === portId ? { ...p, label } : p)))}
          onDelete={(portId) => setPorts((now) => now.filter((p) => p.id !== portId))}
          wrapRow={(row, content) => {
            const port = portOf.get(row.id)
            return port ? (
              <Pin type={port.handleType} id={portHandleId(side, port.id)}>
                {content}
              </Pin>
            ) : null
          }}
          rowEnd={(row) => {
            const port = portOf.get(row.id)
            if (!port || !takesChoices(side, port)) {
              return null
            }
            const open = openChoices === port.id
            return (
              <Button
                variant={open ? 'secondary' : 'ghost'}
                size='xs'
                className='shrink-0 tabular-nums pointer-coarse:h-11'
                aria-label={`Choices of ${port.label}`}
                aria-expanded={open}
                onClick={() => setOpenChoices(open ? null : port.id)}
              >
                <ListChecks />
                {port.options?.length ?? 0}
              </Button>
            )
          }}
          rowBelow={(row) => {
            const port = portOf.get(row.id)
            if (!port || !takesChoices(side, port) || openChoices !== port.id) {
              return null
            }
            const choices = port.options ?? []
            const taken = (value: string) => choices.some((c) => c.value === value)
            return (
              <NodeRowList
                label={`Choices of ${port.label}`}
                className='border-l pl-2'
                rows={choices.map((c) => ({ id: c.value, label: c.value }))}
                onReorder={(ids) => setChoices(port.id, (now) => inRowOrder(now, (c) => c.value, ids))}
                onRename={(was, value) => {
                  if (!taken(value)) {
                    setChoices(port.id, (now) => now.map((c) => (c.value === was ? { ...c, value } : c)))
                  }
                }}
                onDelete={(value) => setChoices(port.id, (now) => now.filter((c) => c.value !== value))}
                add={{
                  label: `New choice of ${port.label}`,
                  placeholder: 'Add a choice…',
                  onAdd: (value) => {
                    if (!taken(value)) {
                      setChoices(port.id, (now) => [...now, { value }])
                    }
                  },
                }}
              />
            )
          }}
        />
        <Pin type='' id={NEW_PORT_HANDLE} color='var(--muted-foreground)'>
          <span className='truncate text-[10px] text-muted-foreground italic'>
            {inputs ? 'Connect to add an input' : 'Connect to add an output'}
          </span>
        </Pin>
      </div>
    </NodeFrame>
  )
})
