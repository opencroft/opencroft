import { legacy, TerminalSelector } from '@opencroft/client'

const { Button, Input, Label, NodeFrame, OutputHandle, React, icons, invoke, toast, useUpdateNodeInternals } = legacy

import { routeHandleId, routeOutput, type TerminalRoute, type TerminalRouterData } from './terminal-router-shared'

const { useEffect, useState } = React

export const TERMINAL_ROUTER_HANDLES = [
  { id: 'route-', contextType: 'terminal-context', role: 'source', label: 'Terminal', dynamic: true },
]

export const terminalRouterExposeOutput = (handleId: string, data: TerminalRouterData) => routeOutput(handleId, data)

export function TerminalRouterNode({
  id,
  data,
  selected,
}: {
  id: string
  data: TerminalRouterData
  selected?: boolean
}) {
  const routes = data.routes ?? []
  const updateNodeInternals = useUpdateNodeInternals()
  const handleKey = routes.map((route) => route.id).join(',')

  // Outputs come and go with the route list; React Flow has to re-measure the
  // node to know where the new handles are.
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, handleKey, updateNodeInternals])

  return (
    <NodeFrame
      icon={icons.Split}
      title={data.name || 'Terminal Router'}
      subtitle={routes.length > 0 ? `${routes.length} terminals` : 'no terminals'}
      selected={selected ?? false}
    >
      {routes.length > 0 ? (
        <div className='flex flex-col gap-0.5'>
          {routes.map((route) => (
            <OutputHandle key={route.id} type='terminal-context' id={routeHandleId(route)}>
              <span
                className={`text-[10px] truncate max-w-[180px] ${route.context ? '' : 'text-muted-foreground italic'}`}
                title={route.context ? route.target : `${route.target} (unavailable)`}
              >
                {route.title}
              </span>
            </OutputHandle>
          ))}
        </div>
      ) : null}
    </NodeFrame>
  )
}

export function TerminalRouterInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: TerminalRouterData
  updateData: (p: Partial<TerminalRouterData>) => void
}) {
  const routes = data.routes ?? []
  const [adding, setAdding] = useState(false)

  const addRoute = async (target: string, option?: { title: string }) => {
    if (!target || routes.some((route) => route.target === target)) {
      return
    }
    setAdding(true)
    // Resolved now rather than left to the next save: this tab never reads
    // back what the server resolves for its own save, so an edge drawn from the
    // new output would carry nothing until a reload.
    let context: unknown
    try {
      context = await invoke('terminalRouter.resolve', target)
    } catch (err) {
      toast.error(`Terminal ${target} does not resolve: ${err instanceof Error ? err.message : String(err)}`)
    }
    const route: TerminalRoute = {
      id: crypto.randomUUID().slice(0, 8),
      target,
      title: option?.title ?? target,
      context,
    }
    updateData({ routes: [...routes, route] })
    setAdding(false)
  }

  const removeRoute = (id: string) => {
    updateData({ routes: routes.filter((route) => route.id !== id) })
  }

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='Terminal Router'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Terminals</Label>
        {routes.length > 0 ? (
          <div className='flex flex-col gap-1'>
            {routes.map((route) => (
              <div key={route.id} className='flex items-center gap-1.5 rounded border px-2 py-1'>
                <icons.TerminalSquare className='h-3 w-3 shrink-0 text-muted-foreground' />
                <span className='text-xs flex-1 truncate' title={route.target}>
                  {route.title}
                </span>
                {route.context ? null : <span className='text-[10px] text-muted-foreground italic'>unavailable</span>}
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-5 px-1 text-destructive'
                  onClick={() => removeRoute(route.id)}
                  title='Remove'
                >
                  <icons.Trash2 className='h-3 w-3' />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className='text-[10px] text-muted-foreground italic'>No terminals routed yet.</p>
        )}
        <TerminalSelector value='' onChange={addRoute} placeholder='Add terminal…' disabled={adding} />
      </div>
    </div>
  )
}
