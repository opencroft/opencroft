import { type ExecutionMode, legacy } from '@opencroft/client'

const {
  Input,
  Label,
  NodeFrame,
  OutputHandle,
  React,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  icons,
} = legacy

import type { AgentToolData } from './agent-tool-shared'

const { useMemo } = React

// How a caller waits for the tool. The host reads `data.execution` when it
// lists and dispatches the tool; the handler behind it is the same either way.
const SYNC = { value: 'sync', label: 'Sync', hint: 'The caller waits for the handler and gets its result.' } as const
const EXECUTION_CHOICES: { value: ExecutionMode; label: string; hint: string }[] = [
  SYNC,
  {
    value: 'awaitable',
    label: 'Awaitable',
    hint: 'The caller may pass background: true to get a task id at once; the result reaches its conversation when the handler ends.',
  },
  {
    value: 'async',
    label: 'Async',
    hint: 'Every call answers at once with a task id; the result reaches the caller’s conversation when the handler ends.',
  },
]

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
  // Anything but the three reads as sync, here as in the host's registry.
  const execution = EXECUTION_CHOICES.find((choice) => choice.value === data.execution) ?? SYNC

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
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Execution</Label>
        <Select
          value={execution.value}
          items={EXECUTION_CHOICES}
          onValueChange={(v) => {
            const chosen = EXECUTION_CHOICES.find((choice) => choice.value === v)
            if (chosen) {
              updateData({ execution: chosen.value })
            }
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXECUTION_CHOICES.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className='text-[10px] text-muted-foreground'>{execution.hint}</p>
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
  { id: 'exec-out', handleType: 'execution-context', role: 'source' as const, label: 'Handler' },
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
