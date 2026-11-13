import { InputHandle, NodeFrame, OutputHandle, useUpdateNodeInternals } from '@opencroft/client/canvas'
import { Input, Label } from '@opencroft/client/ui'
import { Workflow } from 'lucide-react'
import { useEffect } from 'react'

import { PinColumns } from './pin-columns'
import { portHandleId, portsOf, type SubgraphData, subgraphName } from './subgraph-shared'

export function SubgraphNode({ id, data, selected }: { id: string; data: SubgraphData; selected?: boolean }) {
  const { inputs, outputs } = portsOf(data)
  const updateNodeInternals = useUpdateNodeInternals()
  const handleKey = [...inputs.map((p) => p.id), '|', ...outputs.map((p) => p.id)].join(',')

  // Handles come and go with the ports; React Flow has to re-measure the node
  // to know where the new ones are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleKey is only a re-run trigger, the effect does not read it
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, handleKey, updateNodeInternals])

  return (
    <NodeFrame icon={Workflow} title={subgraphName(data)} selected={selected ?? false}>
      {/* No ports gives the frame no body at all, rather than an empty one. */}
      {inputs.length + outputs.length > 0 ? (
        <PinColumns
          inputs={inputs.map((port) => (
            <InputHandle key={port.id} type={port.handleType} id={portHandleId('inputs', port.id)}>
              <span className='truncate text-[10px] text-muted-foreground'>{port.label}</span>
            </InputHandle>
          ))}
          outputs={outputs.map((port) => (
            <OutputHandle key={port.id} type={port.handleType} id={portHandleId('outputs', port.id)}>
              <span className='truncate text-[10px] text-muted-foreground'>{port.label}</span>
            </OutputHandle>
          ))}
        />
      ) : undefined}
    </NodeFrame>
  )
}

export function SubgraphInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: SubgraphData
  updateData: (p: Partial<SubgraphData>) => void
}) {
  return (
    <div className='flex flex-col gap-1'>
      <Label className='text-xs'>Name</Label>
      <Input value={data.name ?? ''} onChange={(e) => updateData({ name: e.target.value })} className='h-7 text-xs' />
    </div>
  )
}
