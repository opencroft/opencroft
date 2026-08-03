import { legacy } from '@opencroft/client'
const { Input, InputHandle, Label, NodeFrame, React, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, icons, useGraphEdges, useGraphNodes } = legacy

import {
  buildSessionKey,
  type EdgeLike,
  listAgentNames,
  listJobNames,
  type NodeLike,
  resolveSessionOnGraph,
  slug,
} from './send-message-helpers'

export interface SendMessageData {
  defaultAgent?: string
  defaultJob?: string
  titleOverride?: string
}

const NONE = '__none__'

// ─── SendMessage Node ────────────────────────────────────────────────

export function SendMessageNode({ data, selected }: { id: string; data: SendMessageData; selected?: boolean }) {
  const nodes = useGraphNodes() as NodeLike[]
  const edges = useGraphEdges() as EdgeLike[]
  const fallback = fallbackKey(data)
  const ctx = fallback ? resolveSessionOnGraph(fallback, nodes, edges) : null

  return (
    <NodeFrame
      icon={icons.Send}
      title='Send Message'
      subtitle={ctx ? `→ ${ctx.agentName} / ${ctx.jobName}` : 'JSON { session, message }'}
      selected={selected ?? false}
    >
      <div className='flex flex-col gap-1.5'>
        <InputHandle type='text-stream' id='text-in'>
          <span className='text-[10px] text-muted-foreground'>Text</span>
        </InputHandle>
      </div>
    </NodeFrame>
  )
}

// ─── Inspector ───────────────────────────────────────────────────────

export function SendMessageInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: SendMessageData
  updateData: (p: Partial<SendMessageData>) => void
}) {
  const nodes = useGraphNodes() as NodeLike[]
  const agents = listAgentNames(nodes)
  const jobs = listJobNames(nodes)

  const onAgent = (v: string) => {
    updateData({ defaultAgent: v === NONE ? '' : slug(v) })
  }
  const onJob = (v: string) => {
    updateData({ defaultJob: v === NONE ? '' : slug(v) })
  }

  return (
    <div className='flex flex-col gap-3'>
      <p className='text-[10px] text-muted-foreground'>
        Accepts JSON <code>{'{ agent?, job?, key?, title?, message }'}</code> on the input. The target agent and job
        fall back to the defaults below when omitted; the message is sent only when both resolve to matching Agent and
        Agent Job nodes in this space. An optional <code>key</code> gives the same agent+job several independent
        sessions; an optional <code>title</code> names a session when it is first created (a legacy
        <code> agent:&lt;agent&gt;:&lt;job&gt;</code> <code>session</code> string is also accepted).
      </p>

      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Default Agent</Label>
        <Select value={data.defaultAgent || NONE} onValueChange={onAgent}>
          <SelectTrigger className='h-8 text-xs'>
            <SelectValue placeholder='None' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {agents.map((name) => (
              <SelectItem key={slug(name)} value={slug(name)}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Default Job</Label>
        <Select value={data.defaultJob || NONE} onValueChange={onJob}>
          <SelectTrigger className='h-8 text-xs'>
            <SelectValue placeholder='None' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {jobs.map((name) => (
              <SelectItem key={slug(name)} value={slug(name)}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Title Override</Label>
        <Input
          className='h-8 text-xs'
          placeholder='Session title (optional)'
          value={data.titleOverride || ''}
          onChange={(e) => updateData({ titleOverride: e.target.value })}
        />
      </div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fallbackKey(data: SendMessageData): string | null {
  const a = (data.defaultAgent || '').trim()
  const j = (data.defaultJob || '').trim()
  if (!a || !j) {
    return null
  }
  return buildSessionKey(a, j)
}

// ─── Handles ─────────────────────────────────────────────────────────

export const SEND_MESSAGE_HANDLES = [
  { id: 'text-in', contextType: 'text-stream', role: 'target' as const, label: 'Text' },
]
