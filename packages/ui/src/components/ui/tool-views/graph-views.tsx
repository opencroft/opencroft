import type { ToolViewProps } from 'agent-chat/tool-views'
import { GitCompare } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '../button'
import { cn } from 'cn'
import { ApprovalDiff, ApprovalFields, DefaultToolView, FieldRow, NodeRow, Note } from './approval-fields'
import { lineDiff } from './diff-view'
import { editSides, textEdit } from './edit-sides'
import { DiffOpBlock, exceedsClamp, linesLabel, OpBlock, OpFields, OpMeta, OpRow, OpText } from './op-block'
import { GenericToolView } from './run-views'
import { type ToolViewNode, useToolViewHost } from './tool-view-host'
// Type-only: the registry imports these views, so a value import back would be
// a cycle.
import type { ToolViewSpec } from './tool-views'

// Views of the graph's writes — a node property written or edited, a batch of
// node updates — and the app_call they arrive through.

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function useNode(nodeId: string | undefined): ToolViewNode | undefined {
  const { canvas } = useToolViewHost()
  return nodeId ? canvas?.getNode(nodeId) : undefined
}

// A string property as the canvas holds it now, or null where there is no
// canvas, no such node, or the value is not text.
function useLiveProperty(nodeId: string | undefined, path: string | undefined): string | null {
  const node = useNode(nodeId)
  const raw = node && path ? getByPath(node.data ?? {}, path) : undefined
  return typeof raw === 'string' ? raw : null
}

function useNodeName(nodeId: string): string {
  return (useNode(nodeId)?.data?.name as string | undefined) ?? nodeId
}

export function WriteNodePropertyView({ args, mode, result }: ToolViewProps) {
  const nodeId = args.nodeId as string | undefined
  const propPath = args.path as string | undefined
  const value = (args.value as string | undefined) ?? ''
  // Only an approval diffs: once the write ran, the property holds `value`.
  const live = useLiveProperty(mode === 'approval' ? nodeId : undefined, propPath)
  const diff = useMemo(() => lineDiff(live ?? '', value), [live, value])

  if (mode === 'approval') {
    return (
      <ApprovalFields>
        {nodeId && <NodeRow nodeId={nodeId} />}
        {propPath && <FieldRow label='Property' value={propPath} />}
        <ApprovalDiff label={propPath} diff={diff} />
      </ApprovalFields>
    )
  }
  return (
    <OpBlock
      verb='Write property'
      detail={propPath}
      target={nodeId}
      meta={<OpMeta text={linesLabel(value)} />}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(value)}
    >
      <OpRow label='value'>
        <OpText text={value} />
      </OpRow>
    </OpBlock>
  )
}

export function EditNodePropertyView({ args, mode, result }: ToolViewProps) {
  const nodeId = args.nodeId as string | undefined
  const propPath = args.path as string | undefined
  const edit = textEdit(args)
  const live = useLiveProperty(nodeId, propPath)
  const { original, value } = editSides(mode, live, edit)
  const diff = useMemo(() => lineDiff(original, value), [original, value])

  if (mode === 'approval') {
    return (
      <ApprovalFields>
        {nodeId && <NodeRow nodeId={nodeId} />}
        {propPath && <FieldRow label='Property' value={propPath} />}
        {edit.replaceAll && <Note>Replaces every occurrence.</Note>}
        <ApprovalDiff label={propPath} diff={diff} />
      </ApprovalFields>
    )
  }
  return <DiffOpBlock verb='Edit property' detail={propPath} target={nodeId} result={result} diffs={[diff]} />
}

interface NodeUpdate {
  nodeId: string
  data?: Record<string, unknown>
  position?: { x: number; y: number }
}

// What an update sets, as named values: each data property it writes, and the
// position when it moves the node.
function updatedValues(update: NodeUpdate): Record<string, unknown> {
  return {
    ...(update.data ?? {}),
    ...(update.position ? { position: `${update.position.x}, ${update.position.y}` } : {}),
  }
}

// The same named values as `updatedValues`, read off the node as it is now,
// one "name: value" line each — the "before" of an update's diff.
function valueLines(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n')
}

function UpdateDiff({ update }: { update: NodeUpdate }) {
  const node = useNode(update.nodeId)
  const name = useNodeName(update.nodeId)
  const diff = useMemo(() => {
    const next = updatedValues(update)
    const current = Object.fromEntries(
      Object.keys(next)
        .map((key): [string, unknown] =>
          key === 'position'
            ? ['position', node?.position ? `${node.position.x}, ${node.position.y}` : undefined]
            : [key, node?.data?.[key]],
        )
        .filter(([, value]) => value !== undefined),
    )
    return lineDiff(valueLines(current), valueLines(next))
  }, [node, update])
  return <ApprovalDiff label={name} diff={diff} />
}

function UpdateButton({ update, active, onToggle }: { update: NodeUpdate; active: boolean; onToggle: () => void }) {
  const name = useNodeName(update.nodeId)
  return (
    <Button
      variant='outline'
      size='sm'
      className={cn('w-full justify-start font-normal', active && 'border-primary ring-1 ring-primary/40')}
      onClick={onToggle}
    >
      <GitCompare />
      <span className='min-w-0 flex-1 truncate text-left'>{name}</span>
      <span className='min-w-0 shrink truncate text-[10px] text-muted-foreground'>
        {Object.keys(updatedValues(update)).join(', ') || 'no changes'}
      </span>
    </Button>
  )
}

function UpdatedNode({ update }: { update: NodeUpdate }) {
  return (
    <div className='border-b last:border-b-0'>
      <div className='px-3 pt-1.5 font-mono text-[11px] font-medium'>{useNodeName(update.nodeId)}</div>
      <OpFields values={updatedValues(update)} />
    </div>
  )
}

export function UpdateNodesView({ args, requestId, mode, result }: ToolViewProps) {
  const updates = (args.updates ?? []) as NodeUpdate[]
  const [openId, setOpenId] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies(requestId): collapse the open diff when a new request arrives
  useEffect(() => {
    setOpenId(null)
  }, [requestId])

  if (mode === 'history') {
    const only = updates.length === 1 ? updates[0] : undefined
    return (
      <OpBlock
        verb='Update'
        detail={only ? undefined : `${updates.length} nodes`}
        target={only?.nodeId}
        isError={result?.isError}
        pending={!result}
        overflowing={updates.length > 1 || Object.keys(only ? updatedValues(only) : {}).length > 3}
      >
        {updates.map((update) => (
          <UpdatedNode key={update.nodeId} update={update} />
        ))}
      </OpBlock>
    )
  }

  if (!updates.length) {
    return (
      <ApprovalFields>
        <Note>No updates.</Note>
      </ApprovalFields>
    )
  }

  const open = updates.find((update) => update.nodeId === openId)
  return (
    <ApprovalFields>
      <Note>
        {updates.length} node{updates.length === 1 ? '' : 's'} to update
      </Note>
      <div className='space-y-1'>
        {updates.map((update) => (
          <UpdateButton
            key={update.nodeId}
            update={update}
            active={update.nodeId === openId}
            onToggle={() => setOpenId(update.nodeId === openId ? null : update.nodeId)}
          />
        ))}
      </div>
      {open && <UpdateDiff update={open} />}
    </ApprovalFields>
  )
}

// ── app_call ────────────────────────────────────────────────────────────
//
// The three graph writes above run through app_call, so the transcript's
// programmatic name for all of them is 'app_call' — only `args.action` tells
// them apart. An approval arrives keyed by the server's own `view`
// ('graph.updateNodes', …) but with the same app_call args, `{ app, action,
// params }`, so those keys resolve to the very same spec: one view that peels
// `params` off for the inner graph view, whichever way a caller arrived.
// GRAPH_ACTION_VIEWS is the single place a graph action's view and its params
// shape are declared. Matching checks the params shape, not just the action
// id, because an extension App can declare an action with the same id as one
// of the graph's — an id match alone would let an unrelated call borrow the
// graph's view.

export const argNodeId = (args: Record<string, unknown>) => args.nodeId as string | undefined

const GRAPH_ACTION_VIEWS: Readonly<
  Record<string, { view: ToolViewSpec; matches: (params: Record<string, unknown>) => boolean }>
> = {
  updateNodes: {
    view: { body: UpdateNodesView },
    matches: (params) => Array.isArray(params.updates),
  },
  writeNodeProperty: {
    view: { body: WriteNodePropertyView, getNodeId: argNodeId },
    matches: (params) => typeof params.nodeId === 'string' && typeof params.path === 'string',
  },
  editNodeProperty: {
    view: { body: EditNodePropertyView, getNodeId: argNodeId },
    matches: (params) =>
      typeof params.nodeId === 'string' &&
      typeof params.path === 'string' &&
      typeof params.oldString === 'string' &&
      typeof params.newString === 'string',
  },
}

// Resolves an app_call's own args, `{ app, action, params }`, to the graph
// view its action names and the params to render that view with — or
// undefined when the action isn't one of the graph's, or its params don't
// match that action's shape.
export function appActionView(
  args: Record<string, unknown>,
): { view: ToolViewSpec; params: Record<string, unknown> } | undefined {
  const action = args.action as string | undefined
  const params = args.params
  if (!action || typeof params !== 'object' || params === null || Array.isArray(params)) {
    return undefined
  }
  const graphAction = Object.hasOwn(GRAPH_ACTION_VIEWS, action) ? GRAPH_ACTION_VIEWS[action] : undefined
  if (!graphAction || !graphAction.matches(params as Record<string, unknown>)) {
    return undefined
  }
  return { view: graphAction.view, params: params as Record<string, unknown> }
}

// The transcript's entry for every app_call, whichever action it carries:
// render the graph's own view when the action and its params match one,
// otherwise fall back exactly as an unregistered tool would.
export function AppCallView(props: ToolViewProps) {
  const resolved = appActionView(props.args)
  if (!resolved) {
    return props.mode === 'approval' ? (
      <DefaultToolView {...props} />
    ) : (
      <GenericToolView tool={props.tool} args={props.args} result={props.result} />
    )
  }
  const Inner = resolved.view.body
  return <Inner {...props} args={resolved.params} />
}

export function appCallNodeId(args: Record<string, unknown>): string | undefined {
  const resolved = appActionView(args)
  return resolved && resolved.view.getNodeId?.(resolved.params)
}
