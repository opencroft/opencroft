'use client';

import type { PendingApproval } from '@/lib/sse-events';

export interface ApprovalViewProps {
  request: PendingApproval;
}

export interface ApprovalViewSpec {
  body: React.ComponentType<ApprovalViewProps>;
  getNodeId?: (args: Record<string, unknown>) => string | undefined;
}

function formatArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, null, 2);
}

export function DefaultApprovalView({ request }: ApprovalViewProps) {
  return (
    <div className='space-y-1 px-3 py-2'>
      <div className='text-xs font-medium text-muted-foreground'>Arguments</div>
      <pre className='text-xs whitespace-pre-wrap break-all bg-muted/50 rounded-md p-2 max-h-72 overflow-auto font-mono'>
        {formatArgs(request.args)}
      </pre>
    </div>
  );
}

const DEFAULT_SPEC: ApprovalViewSpec = { body: DefaultApprovalView };

const registry = new Map<string, ApprovalViewSpec>();

export function registerApprovalView(id: string, spec: ApprovalViewSpec): void {
  registry.set(id, spec);
}

export function resolveApprovalView(id?: string): ApprovalViewSpec {
  if (!id) {
    return DEFAULT_SPEC;
  }
  return registry.get(id) ?? DEFAULT_SPEC;
}
