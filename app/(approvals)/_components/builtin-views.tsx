'use client';

import { useReactFlow } from '@xyflow/react';
import { GitCompare } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';

import {
  ApprovalViewProps,
  registerApprovalView,
} from '@/app/(approvals)/_components/approval-views';
import { NodeDiffEditor } from '@/app/(approvals)/_components/node-diff-editor';
import { CanvasContentContext } from '@/app/(dashboard)/_canvas/canvas-content-context';
import { NodeCard } from '@/app/(dashboard)/_canvas/node-card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className='space-y-0.5'>
      <div className='text-xs font-medium text-muted-foreground'>{label}</div>
      <pre className='text-xs whitespace-pre-wrap break-all bg-muted/50 rounded-md p-2 max-h-40 overflow-auto font-mono'>
        {value}
      </pre>
    </div>
  );
}

function NodeRow({ nodeId }: { nodeId: string }) {
  const { getNode } = useReactFlow();
  const node = getNode(nodeId) as { data?: { name?: string } } | undefined;
  const name = node?.data?.name;
  const value = name ? `${name} (${nodeId})` : nodeId;
  return <FieldRow label='Node' value={value} />;
}

function RemoteExecView({ request }: ApprovalViewProps) {
  const target = request.args.target as string | undefined;
  const command = request.args.command as string | undefined;
  const secrets = request.args.secrets as string[] | undefined;
  const description = request.args.description as string | undefined;

  return (
    <div className='space-y-3 px-3 py-2'>
      {description && <FieldRow label='Description' value={description} />}
      {target && <FieldRow label='Target' value={target} />}
      {command && <FieldRow label='Command' value={command} />}
      {secrets && secrets.length > 0 && <FieldRow label='Secrets' value={secrets.join(', ')} />}
    </div>
  );
}

function CallView({ request }: ApprovalViewProps) {
  const nodeId = request.args.nodeId as string | undefined;
  const action = request.args.action as string | undefined;
  const params = request.args.params as Record<string, unknown> | undefined;
  const paramsText = params && Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : null;

  return (
    <div className='space-y-3 px-3 py-2'>
      {nodeId && <NodeRow nodeId={nodeId} />}
      {action && <FieldRow label='Action' value={action} />}
      {paramsText && <FieldRow label='Params' value={paramsText} />}
    </div>
  );
}

interface NodeUpdate {
  nodeId: string;
  data?: Record<string, unknown>;
  position?: { x: number; y: number };
}

function changeSummary(update: NodeUpdate): string {
  const parts: string[] = [];
  if (update.data && Object.keys(update.data).length > 0) {
    parts.push(`data: ${Object.keys(update.data).join(', ')}`);
  }
  if (update.position) {
    parts.push('position');
  }
  return parts.join(' · ') || 'no changes';
}

function NodeDiff({ update }: { update: NodeUpdate }) {
  const { getNode } = useReactFlow();
  const node = getNode(update.nodeId) as { data?: Record<string, unknown>; position?: { x: number; y: number } } | undefined;
  const name = (node?.data?.name as string | undefined) ?? update.nodeId;
  const current = {
    ...(update.data ? { data: node?.data ?? {} } : {}),
    ...(update.position ? { position: node?.position } : {}),
  };
  const next = {
    ...(update.data ? { data: { ...(node?.data ?? {}), ...update.data } } : {}),
    ...(update.position ? { position: update.position } : {}),
  };

  return (
    <div className='px-3 py-2 space-y-2'>
      <div className='font-mono text-xs'>
        {name} <span className='text-muted-foreground'>({update.nodeId})</span>
      </div>
      <NodeDiffEditor
        current={JSON.stringify(current, null, 2)}
        next={JSON.stringify(next, null, 2)}
      />
    </div>
  );
}

function UpdateNodesView({ request }: ApprovalViewProps) {
  const updates = (request.args.updates ?? []) as NodeUpdate[];
  const { getNode } = useReactFlow();
  const setCanvasContent = useContext(CanvasContentContext);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!openId) {
      setCanvasContent(null);
      return;
    }
    const update = updates.find((u) => u.nodeId === openId);
    if (!update) {
      setCanvasContent(null);
      return;
    }
    setCanvasContent(
      <div className='p-4'>
        <NodeCard className='w-full'>
          <NodeDiff update={update} />
        </NodeCard>
      </div>,
    );
    return () => setCanvasContent(null);
  }, [openId, updates, setCanvasContent]);

  useEffect(() => {
    setOpenId(null);
  }, [request.id]);

  if (!updates.length) {
    return <div className='px-3 py-2 text-xs text-muted-foreground'>No updates.</div>;
  }

  return (
    <div className='space-y-1.5 px-3 py-2'>
      <div className='text-xs font-medium text-muted-foreground'>
        {updates.length} node{updates.length === 1 ? '' : 's'} to update
      </div>
      <div className='space-y-1'>
        {updates.map((update) => {
          const node = getNode(update.nodeId) as { data?: { name?: string } } | undefined;
          const name = node?.data?.name ?? update.nodeId;
          const active = openId === update.nodeId;
          return (
            <Button
              key={update.nodeId}
              variant='outline'
              size='sm'
              className={cn('justify-start w-full font-normal', active && 'border-primary ring-1 ring-primary/40')}
              onClick={() => setOpenId(active ? null : update.nodeId)}
            >
              <GitCompare />
              <span className='truncate flex-1 text-left'>{name}</span>
              <span className='text-[10px] text-muted-foreground truncate'>{changeSummary(update)}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

registerApprovalView('remote_exec', {
  body: RemoteExecView,
  getNodeId: (args) => (args.target as string | undefined)?.split('/')[0],
});

registerApprovalView('call', {
  body: CallView,
  getNodeId: (args) => args.nodeId as string | undefined,
});

registerApprovalView('update_nodes', {
  body: UpdateNodesView,
});
