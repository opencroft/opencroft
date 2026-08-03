import { icons, NodeFrame, OutputHandle, React } from '@ext/host'
import { Input, Label } from '@ext/ui'

import type { AgentToolData } from './agent-tool-shared'

const { useMemo } = React

export function AgentToolNode({ id, data, selected }: { id: string; data: AgentToolData; selected?: boolean }) {
  const name = data.name ?? 'new_tool'

  return (
    <NodeFrame
      icon={icons.Wrench}
      title={name}
      selected={selected ?? false}
      output={<OutputHandle type='execution-context' id='exec-out' />}
      extra={
        <div className='flex items-center gap-1 text-[10px]'>
          {data.requireApproval && (
            <span className='px-1 py-0.5 bg-amber-500/20 text-amber-400 rounded font-medium'>approval</span>
          )}
        </div>
      }
    />
  )
}

export function AgentToolInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: AgentToolData
  updateData: (p: Partial<AgentToolData>) => void
}) {
  const schemaStr = data.inputSchema ?? '{\n  "type": "object",\n  "properties": {}\n}'

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Tool Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='my_tool'
          className='font-mono'
        />
        <p className='text-[10px] text-muted-foreground'>Unique name. Must not collide with any built-in MCP tool.</p>
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Description</Label>
        <Input
          value={data.description ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ description: e.target.value })}
          placeholder='What this tool does (shown to the agent)'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Input Schema (JSON)</Label>
        <textarea
          value={schemaStr}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ inputSchema: e.target.value })}
          className='flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
          placeholder='{"type": "object", "properties": {}}'
          spellCheck={false}
        />
      </div>
      <div className='flex items-center gap-2'>
        <input
          type='checkbox'
          checked={data.requireApproval ?? false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ requireApproval: e.target.checked })}
          className='rounded border-input'
        />
        <Label
          className='text-xs cursor-pointer'
          onClick={() => updateData({ requireApproval: !data.requireApproval })}
        >
          Require approval before execution
        </Label>
      </div>
    </div>
  )
}

export const AGENT_TOOL_HANDLES = [
  { id: 'exec-out', contextType: 'execution-context', role: 'source' as const, label: 'Handler' },
]

export function agentToolExposeOutput(
  handleId: string,
  data: unknown,
): { name: string; description: string } | undefined {
  if (handleId !== 'exec-out') {
    return undefined
  }
  const d = data as AgentToolData
  return { name: d.name ?? '', description: d.description ?? '' }
}
