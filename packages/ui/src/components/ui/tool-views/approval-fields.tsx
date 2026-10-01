import type { ToolViewProps } from 'agent-chat/tool-views'
import { type ReactNode, useMemo } from 'react'

import { type DiffLine, DiffStat, DiffView } from './diff-view'
import { useToolViewHost } from './tool-view-host'

// The approval face of a tool view: what a call is about to do, stated as
// labelled fields before it runs, with the change it would make shown as a
// diff. Every view's approval form is built from these, so they read alike.

export function ApprovalFields({ children }: { children: ReactNode }) {
  return <div className='min-w-0 space-y-3 px-3 py-2'>{children}</div>
}

export function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0 space-y-0.5'>
      <div className='text-xs font-medium text-muted-foreground'>{label}</div>
      <pre className='max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md bg-muted/50 p-2 font-mono text-xs'>
        {value}
      </pre>
    </div>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return <div className='text-xs text-muted-foreground'>{children}</div>
}

function useNodeLabel(nodeId: string): string {
  const { canvas } = useToolViewHost()
  const name = canvas?.getNode(nodeId)?.data?.name as string | undefined
  return name ? `${name} (${nodeId})` : nodeId
}

export function NodeRow({ nodeId }: { nodeId: string }) {
  return <FieldRow label='Node' value={useNodeLabel(nodeId)} />
}

export function TargetRow({ target }: { target: string }) {
  const [nodeId, handleId] = target.split('/')
  const label = useNodeLabel(nodeId)
  return <FieldRow label='Target' value={handleId ? `${label} / ${handleId}` : label} />
}

// The change an approval would make. Projected into the host's approval panel
// where it has one, which has room the approval list does not; inline
// otherwise. The panel republishes whenever its children change identity, so
// the body is memoised on what it shows.
export function ApprovalDiff({ label, diff }: { label?: string; diff: readonly DiffLine[] }) {
  const { ApprovalPanel } = useToolViewHost()
  const body = useMemo(
    () => (
      <div className='min-w-0 overflow-hidden rounded-md border bg-card'>
        <div className='flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-xs'>
          <span className='min-w-0 flex-1 font-mono wrap-anywhere'>{label}</span>
          <DiffStat diff={diff} />
        </div>
        <DiffView diff={diff} />
      </div>
    ),
    [label, diff],
  )
  const projected = useMemo(() => <div className='p-4'>{body}</div>, [body])
  return ApprovalPanel ? <ApprovalPanel>{projected}</ApprovalPanel> : body
}

// The approval list's fallback: every call has to show something before it is
// approved, and a tool with no view of its own shows its raw arguments.
export function DefaultToolView({ args }: ToolViewProps) {
  return (
    <ApprovalFields>
      <FieldRow label='Arguments' value={JSON.stringify(args, null, 2)} />
    </ApprovalFields>
  )
}
