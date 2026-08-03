import { icons, NodeFrame, OutputHandle, type React } from '@ext/host'
import { Input, Label, Textarea } from '@ext/ui'

export interface AgentInstructionData {
  name: string
  instruction: string
}

export function AgentInstructionNode({
  data,
  selected,
}: {
  id: string
  data: AgentInstructionData
  selected?: boolean
}) {
  return (
    <NodeFrame
      icon={icons.BookOpen}
      title={data.name || 'Agent Instruction'}
      selected={selected ?? false}
      output={<OutputHandle type='agent-instruction' id='instruction-out' />}
    />
  )
}

export function AgentInstructionInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: AgentInstructionData
  updateData: (p: Partial<AgentInstructionData>) => void
}) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='Instruction name'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Instruction</Label>
        <Textarea
          value={data.instruction ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ instruction: e.target.value })}
          placeholder='Instructions to inject into the first message of every chat session…'
          className='min-h-48 font-mono text-xs'
        />
      </div>
    </div>
  )
}
