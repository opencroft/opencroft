import { legacy } from '@opencroft/client'
import type { ChangeEvent } from 'react'

import { storedType } from './stored-type'

const {
  Input,
  Label,
  NodeFrame,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  extensionId,
  icons,
  useGraphNodes,
} = legacy

export interface OpenAIAssistantData {
  name: string
  chatApiBase: string
  chatApiKey: string
  chatModel: string
  temperature: number
}

export function OpenAIAssistantNode({ data, selected }: { data: OpenAIAssistantData; selected?: boolean }) {
  return (
    <NodeFrame
      icon={icons.UserRound}
      title={data.name || 'AI Assistant'}
      subtitle={data.chatModel || '—'}
      selected={selected ?? false}
    >
      <div className='flex flex-col gap-0.5 text-[10px] font-mono text-muted-foreground'>
        {data.chatApiBase ? <div className='truncate'>chat: {data.chatApiBase}</div> : null}
      </div>
    </NodeFrame>
  )
}

export function OpenAIAssistantInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: OpenAIAssistantData
  updateData: (p: Partial<OpenAIAssistantData>) => void
}) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='My Assistant'
        />
      </div>

      <Label className='text-xs font-semibold mt-1'>Chat</Label>
      <div className='flex flex-col gap-1'>
        <Label>API Base</Label>
        <Input
          value={data.chatApiBase ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ chatApiBase: e.target.value })}
          placeholder='https://api.openai.com/v1'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>API Key</Label>
        <Input
          type='password'
          value={data.chatApiKey ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ chatApiKey: e.target.value })}
          placeholder='sk-…'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Model</Label>
        <Input
          value={data.chatModel ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ chatModel: e.target.value })}
          placeholder='gpt-4o-mini'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Temperature</Label>
        <Input
          type='number'
          step='0.1'
          min='0'
          max='2'
          value={data.temperature ?? 0.7}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ temperature: Number(e.target.value) })}
        />
      </div>
    </div>
  )
}

interface AssistantNode {
  id: string
  type?: string
  data: OpenAIAssistantData
}

export function useAssistantsList(): AssistantNode[] {
  const nodes = useGraphNodes()
  return nodes.filter((n) => n.type === storedType(extensionId, 'openai-assistant')) as unknown as AssistantNode[]
}

export function useAssistant(assistantId?: string): OpenAIAssistantData | null {
  const list = useAssistantsList()
  if (!assistantId) {
    return null
  }
  return list.find((n) => n.id === assistantId)?.data ?? null
}

export function AssistantSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = useAssistantsList()
  return (
    <Select
      value={value || '__none'}
      items={[
        { value: '__none', label: 'No assistant' },
        ...list.map((a) => ({ value: a.id, label: a.data.name || a.id })),
      ]}
      onValueChange={(v) => {
        if (v !== null) {
          onChange(v === '__none' ? '' : v)
        }
      }}
    >
      <SelectTrigger>
        <SelectValue placeholder='No assistant' />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value='__none'>No assistant</SelectItem>
        {list.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.data.name || a.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
