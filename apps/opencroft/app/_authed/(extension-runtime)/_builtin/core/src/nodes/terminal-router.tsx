import { legacy, TerminalRef, TerminalSelector } from '@opencroft/client'

const {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  inspectorIntent,
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
  NodeFrame,
  OutputHandle,
  React,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Terminal,
  icons,
  invoke,
  toast,
  useInspectorIntent,
  useReactFlow,
  useUpdateNodeInternals,
} = legacy

import { connectionFromContext } from './terminal'
import { routeHandleId, routeOutput, type TerminalRoute, type TerminalRouterData } from './terminal-router-shared'

const { useCallback, useEffect, useState } = React

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
  const rf = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()

  // The same gesture as a Server node's Terminal pin: select the node and open
  // its inspector's Terminal tab, here on the route that was clicked.
  const openTerminal = useCallback(
    (routeId: string) => {
      rf.setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
      inspectorIntent.open(id, 'terminal', routeId)
    },
    [id, rf],
  )
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
              <Button
                variant='ghost'
                size='sm'
                className='nodrag nopan h-5 text-[10px] px-1.5 max-w-[200px]'
                disabled={!route.context}
                title={route.context ? undefined : 'Terminal unavailable'}
                onClick={() => openTerminal(route.id)}
              >
                <TerminalRef target={route.target} />
              </Button>
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

  const addRoute = async (target: string) => {
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
    const route: TerminalRoute = { id: crypto.randomUUID().slice(0, 8), target, context }
    updateData({ routes: [...routes, route] })
    setAdding(false)
  }

  const removeRoute = (id: string) => {
    updateData({ routes: routes.filter((route) => route.id !== id) })
  }

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor='terminal-router-name'>Name</FieldLabel>
        <Input
          id='terminal-router-name'
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='Terminal Router'
        />
      </Field>
      <Field>
        <FieldLabel>Terminals</FieldLabel>
        {routes.length > 0 ? (
          <ItemGroup>
            {routes.map((route) => (
              <Item key={route.id} size='sm' className='px-0 py-1.5'>
                <ItemContent className='min-w-0'>
                  <ItemTitle className='w-full min-w-0'>
                    <TerminalRef target={route.target} />
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  {route.context ? null : <Badge variant='outline'>unavailable</Badge>}
                  <Button variant='ghost' size='icon' onClick={() => removeRoute(route.id)} title='Remove'>
                    <icons.Trash2 />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <Empty className='p-2'>
            <EmptyHeader>
              <EmptyDescription>No terminals routed yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <TerminalSelector value='' onChange={addRoute} placeholder='Add terminal…' disabled={adding} />
      </Field>
    </FieldGroup>
  )
}

export function TerminalRouterTerminalTab({ nodeId, data }: { nodeId: string; data: TerminalRouterData }) {
  const routes = (data.routes ?? []).filter((route) => route.context)
  const intent = useInspectorIntent(nodeId)
  const route = routes.find((r) => r.id === intent.instanceId) ?? routes[0]
  if (!route) {
    return <div className='p-3 text-xs text-muted-foreground italic'>No available terminals to open.</div>
  }
  const connection = connectionFromContext(route.context as Record<string, unknown>)
  return (
    <div className='flex h-full min-h-0 flex-col gap-2'>
      {routes.length > 1 ? (
        <Select
          value={route.id}
          items={routes.map((r) => ({ value: r.id, label: <TerminalRef target={r.target} /> }))}
          onValueChange={(next) => {
            if (next !== null) {
              inspectorIntent.setInstance(nodeId, next)
            }
          }}
        >
          <SelectTrigger size='sm' className='w-full'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {routes.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                <TerminalRef target={r.target} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <div className='min-h-0 flex-1'>
        {connection ? (
          <Terminal
            key={route.id}
            connection={connection as unknown as import('@opencroft/terminal/client').TerminalConfig}
            sessionKey={`${nodeId}:${route.id}`}
          />
        ) : null}
      </div>
    </div>
  )
}
