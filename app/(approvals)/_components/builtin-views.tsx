'use client';

import { useReactFlow } from '@xyflow/react';
import { GitCompare } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  ApprovalViewProps,
  registerApprovalView,
} from '@/app/(approvals)/_components/approval-views';
import { NodeDiffEditor } from '@/app/(approvals)/_components/node-diff-editor';
import { readRemoteFile } from '@/app/(approvals)/actions';
import { NodeCard } from '@/app/(dashboard)/_canvas/node-card';
import { useOverlayContent } from '@/app/(dashboard)/_canvas/overlay-context';
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

function TargetRow({ target }: { target: string }) {
  const { getNode } = useReactFlow();
  const [nodeId, handleId] = target.split('/');
  const node = getNode(nodeId) as { data?: { name?: string } } | undefined;
  const name = node?.data?.name;
  const label = name ? `${name} (${nodeId})` : nodeId;
  const value = handleId ? `${label} / ${handleId}` : label;
  return <FieldRow label='Target' value={value} />;
}

function useRemoteFileContent(target: string | undefined, space: string | undefined, path: string | undefined, requestId: string) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target || !path) {
      return;
    }
    let cancelled = false;
    setContent(null);
    setError(null);
    readRemoteFile({ data: { target, space, path } }).then((value) => {
      if (!cancelled) {
        setContent(value);
      }
    }).catch((err: Error) => {
      if (!cancelled) {
        setError(err.message);
        setContent('');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [target, space, path, requestId]);

  return { content, error };
}

function RemoteWriteView({ request }: ApprovalViewProps) {
  const target = request.args.target as string | undefined;
  const space = request.args.space as string | undefined;
  const filePath = request.args.path as string | undefined;
  const newContent = (request.args.content as string | undefined) ?? '';
  const { content, error } = useRemoteFileContent(target, space, filePath, request.id);

  const diffNode = useMemo(() => {
    if (content === null) {
      return null;
    }
    return (
      <div className='p-4'>
        <NodeCard className='w-full'>
          <div className='px-3 py-2 space-y-2'>
            <div className='font-mono text-xs'>{filePath}</div>
            <NodeDiffEditor current={content} next={newContent} />
          </div>
        </NodeCard>
      </div>
    );
  }, [content, newContent, filePath]);

  useOverlayContent(diffNode);

  return (
    <div className='space-y-3 px-3 py-2'>
      {target && <TargetRow target={target} />}
      {filePath && <FieldRow label='Path' value={filePath} />}
      {error && <FieldRow label='Note' value={`Could not read existing file: ${error}`} />}
      {content === null && <div className='text-xs text-muted-foreground'>Loading current content…</div>}
    </div>
  );
}

function RemoteEditView({ request }: ApprovalViewProps) {
  const target = request.args.target as string | undefined;
  const space = request.args.space as string | undefined;
  const filePath = request.args.path as string | undefined;
  const oldString = (request.args.oldString as string | undefined) ?? '';
  const newString = (request.args.newString as string | undefined) ?? '';
  const replaceAll = Boolean(request.args.replaceAll);
  const { content, error } = useRemoteFileContent(target, space, filePath, request.id);

  const diffNode = useMemo(() => {
    if (content === null) {
      return null;
    }
    const next = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    return (
      <div className='p-4'>
        <NodeCard className='w-full'>
          <div className='px-3 py-2 space-y-2'>
            <div className='font-mono text-xs'>{filePath}</div>
            <NodeDiffEditor current={content} next={next} />
          </div>
        </NodeCard>
      </div>
    );
  }, [content, oldString, newString, replaceAll, filePath]);

  useOverlayContent(diffNode);

  return (
    <div className='space-y-3 px-3 py-2'>
      {target && <TargetRow target={target} />}
      {filePath && <FieldRow label='Path' value={filePath} />}
      <FieldRow label='Old' value={oldString} />
      <FieldRow label='New' value={newString} />
      {replaceAll && <div className='text-xs text-muted-foreground'>Replace all occurrences</div>}
      {error && <FieldRow label='Note' value={`Could not read existing file: ${error}`} />}
      {content === null && <div className='text-xs text-muted-foreground'>Loading current content…</div>}
    </div>
  );
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function NodePropertyDiff({ nodeId, path, current, next }: { nodeId: string; path: string; current: string; next: string }) {
  const { getNode } = useReactFlow();
  const node = getNode(nodeId) as { data?: { name?: string } } | undefined;
  const name = node?.data?.name ?? nodeId;
  return (
    <div className='p-4'>
      <NodeCard className='w-full'>
        <div className='px-3 py-2 space-y-2'>
          <div className='font-mono text-xs'>
            {name} <span className='text-muted-foreground'>({nodeId})</span> · {path}
          </div>
          <NodeDiffEditor current={current} next={next} />
        </div>
      </NodeCard>
    </div>
  );
}

function WriteNodePropertyView({ request }: ApprovalViewProps) {
  const nodeId = request.args.nodeId as string | undefined;
  const propPath = request.args.path as string | undefined;
  const value = (request.args.value as string | undefined) ?? '';
  const { getNode } = useReactFlow();
  const node = nodeId ? getNode(nodeId) as { data?: Record<string, unknown> } | undefined : undefined;
  const currentRaw = node && propPath ? getByPath(node.data ?? {}, propPath) : undefined;
  const current = typeof currentRaw === 'string' ? currentRaw : '';

  const diffNode = useMemo(() => {
    if (!nodeId || !propPath) {
      return null;
    }
    return <NodePropertyDiff nodeId={nodeId} path={propPath} current={current} next={value} />;
  }, [nodeId, propPath, current, value]);

  useOverlayContent(diffNode);

  return (
    <div className='space-y-3 px-3 py-2'>
      {nodeId && <NodeRow nodeId={nodeId} />}
      {propPath && <FieldRow label='Path' value={propPath} />}
    </div>
  );
}

function EditNodePropertyView({ request }: ApprovalViewProps) {
  const nodeId = request.args.nodeId as string | undefined;
  const propPath = request.args.path as string | undefined;
  const oldString = (request.args.oldString as string | undefined) ?? '';
  const newString = (request.args.newString as string | undefined) ?? '';
  const replaceAll = Boolean(request.args.replaceAll);
  const { getNode } = useReactFlow();
  const node = nodeId ? getNode(nodeId) as { data?: Record<string, unknown> } | undefined : undefined;
  const currentRaw = node && propPath ? getByPath(node.data ?? {}, propPath) : undefined;
  const current = typeof currentRaw === 'string' ? currentRaw : '';

  const diffNode = useMemo(() => {
    if (!nodeId || !propPath) {
      return null;
    }
    const next = replaceAll
      ? current.split(oldString).join(newString)
      : current.replace(oldString, newString);
    return <NodePropertyDiff nodeId={nodeId} path={propPath} current={current} next={next} />;
  }, [nodeId, propPath, current, oldString, newString, replaceAll]);

  useOverlayContent(diffNode);

  return (
    <div className='space-y-3 px-3 py-2'>
      {nodeId && <NodeRow nodeId={nodeId} />}
      {propPath && <FieldRow label='Path' value={propPath} />}
      <FieldRow label='Old' value={oldString} />
      <FieldRow label='New' value={newString} />
      {replaceAll && <div className='text-xs text-muted-foreground'>Replace all occurrences</div>}
    </div>
  );
}

function RemoteExecView({ request }: ApprovalViewProps) {
  const target = request.args.target as string | undefined;
  const command = request.args.command as string | undefined;
  const secrets = request.args.secrets as string[] | undefined;
  const description = request.args.description as string | undefined;

  return (
    <div className='space-y-3 px-3 py-2'>
      {target && <TargetRow target={target} />}
      {description && <FieldRow label='Description' value={description} />}
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
  const [openId, setOpenId] = useState<string | null>(null);

  const openUpdate = openId ? updates.find((u) => u.nodeId === openId) ?? null : null;
  const diffNode = useMemo(() => {
    if (!openUpdate) {
      return null;
    }
    return (
      <div className='p-4'>
        <NodeCard className='w-full'>
          <NodeDiff update={openUpdate} />
        </NodeCard>
      </div>
    );
  }, [openUpdate]);

  useOverlayContent(diffNode);

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

registerApprovalView('remote_write', {
  body: RemoteWriteView,
  getNodeId: (args) => (args.target as string | undefined)?.split('/')[0],
});

registerApprovalView('remote_edit', {
  body: RemoteEditView,
  getNodeId: (args) => (args.target as string | undefined)?.split('/')[0],
});

registerApprovalView('call', {
  body: CallView,
  getNodeId: (args) => args.nodeId as string | undefined,
});

registerApprovalView('update_nodes', {
  body: UpdateNodesView,
});

registerApprovalView('write_node_property', {
  body: WriteNodePropertyView,
  getNodeId: (args) => args.nodeId as string | undefined,
});

registerApprovalView('edit_node_property', {
  body: EditNodePropertyView,
  getNodeId: (args) => args.nodeId as string | undefined,
});
