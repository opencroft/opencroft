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
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  NodeFrame,
  OutputHandle,
  React,
  icons,
  invoke,
  toast,
  useUpdateNodeInternals,
} = legacy

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
              <TerminalRef
                target={route.target}
                className={`text-[10px] max-w-[180px] ${route.context ? '' : 'text-muted-foreground italic'}`}
              />
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
          <ItemGroup className='gap-1'>
            {routes.map((route) => (
              <Item key={route.id} variant='outline' size='sm'>
                <ItemMedia variant='icon'>
                  <icons.TerminalSquare />
                </ItemMedia>
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
          <Empty className='border border-dashed p-4'>
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
