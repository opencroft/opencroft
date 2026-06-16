import { icons, NodeFrame, OutputHandle, type React } from '@ext/host'
import { Input, Label, Textarea } from '@ext/ui'

export interface AgentJobData {
  name: string
  workingDirectory: string
  context: string
}

export function AgentJobNode({ data, selected }: { id: string; data: AgentJobData; selected?: boolean }) {
  return (
    <NodeFrame
      icon={icons.Briefcase}
      title={data.name || 'Agent Job'}
      selected={selected ?? false}
      output={<OutputHandle type='agent-job' id='job-out' />}
    />
  )
}

export function AgentJobInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: AgentJobData
  updateData: (p: Partial<AgentJobData>) => void
}) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='Job name'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Working directory</Label>
        <Input
          value={data.workingDirectory ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ workingDirectory: e.target.value })}
          placeholder='/path/to/workspace'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Context</Label>
        <Textarea
          value={data.context ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ context: e.target.value })}
          placeholder='Plain-text context for the job…'
          className='min-h-48 font-mono text-xs'
        />
      </div>
    </div>
  )
}
