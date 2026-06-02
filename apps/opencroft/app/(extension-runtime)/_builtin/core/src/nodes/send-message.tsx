import {
  React,
  NodeFrame,
  InputHandle,
  icons,
  useGraphEdges,
  useGraphNodes,
} from '@ext/host';
import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ext/ui';

import {
  buildSessionKey,
  listAgentNames,
  listJobNames,
  resolveSessionOnGraph,
  slug,
  type NodeLike,
  type EdgeLike,
} from './send-message-helpers';

export interface SendMessageData {
  defaultAgent?: string;
  defaultJob?: string;
}

const NONE = '__none__';

// ─── SendMessage Node ────────────────────────────────────────────────

export function SendMessageNode({
  data, selected,
}: { id: string; data: SendMessageData; selected?: boolean }) {
  const nodes = useGraphNodes() as NodeLike[];
  const edges = useGraphEdges() as EdgeLike[];
  const fallback = fallbackKey(data);
  const ctx = fallback ? resolveSessionOnGraph(fallback, nodes, edges) : null;

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
  );
}

// ─── Inspector ───────────────────────────────────────────────────────

export function SendMessageInspector({
  data, updateData,
}: { nodeId: string; data: SendMessageData; updateData: (p: Partial<SendMessageData>) => void }) {
  const nodes = useGraphNodes() as NodeLike[];
  const agents = listAgentNames(nodes);
  const jobs = listJobNames(nodes);

  const onAgent = (v: string) => {
    updateData({ defaultAgent: v === NONE ? '' : slug(v) });
  };
  const onJob = (v: string) => {
    updateData({ defaultJob: v === NONE ? '' : slug(v) });
  };

  return (
    <div className='flex flex-col gap-3'>
      <p className='text-[10px] text-muted-foreground'>
        Accepts JSON <code>{'{ session, message }'}</code> on the input. Session must look like
        <code> agent:&lt;agent-slug&gt;:&lt;job-slug&gt;</code>; the message is sent only when both
        slugs match nodes in this space. Fallback target below is used when the input is plain text.
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
              <SelectItem key={slug(name)} value={slug(name)}>{name}</SelectItem>
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
              <SelectItem key={slug(name)} value={slug(name)}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fallbackKey(data: SendMessageData): string | null {
  const a = (data.defaultAgent || '').trim();
  const j = (data.defaultJob || '').trim();
  if (!a || !j) {
    return null;
  }
  return buildSessionKey(a, j);
}

// ─── Handles ─────────────────────────────────────────────────────────

export const SEND_MESSAGE_HANDLES = [
  { id: 'text-in', contextType: 'text-stream', role: 'target' as const, label: 'Text' },
];
