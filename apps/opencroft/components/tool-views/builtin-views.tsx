'use client'

import { DiffEditor } from 'agent-chat/diff-editor'

// @xyflow/react's `useKeyPress` calls `preventDefault()` on the keys it watches
// unless the event came from an element its `isInputDOMNode` recognises —
// INPUT / SELECT / TEXTAREA, `contenteditable`, or a `.nokey` ancestor. Monaco
// takes input through the EditContext API on a plain div, so a caret inside a
// diff would send Backspace to the canvas as node deletion. `nokey` is xyflow's
// own opt-out, applied here rather than in agent-chat: the canvas is a host
// concern and that package stays host-agnostic.
function CanvasSafeDiffEditor(props: { current: string; next: string }) {
  return (
    <div className='nokey'>
      <DiffEditor {...props} />
    </div>
  )
}

import { GitCompare, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'

import { readRemoteFile } from '@/app/_authed/(approvals)/_server/actions'
import { useCanvasNodes } from '@/app/_authed/(dashboard)/_canvas/canvas-nodes-context'
import { NodeCard } from '@/app/_authed/(dashboard)/_canvas/node-card'
import { useOptionalOverlay } from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { cn } from '@/lib/utils'
import { exceedsClamp, OpBlock, OpRow } from './op-block'
import { registerToolView, type ToolViewProps } from './registry'

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className='space-y-0.5'>
      <div className='text-xs font-medium text-muted-foreground'>{label}</div>
      <pre className='text-xs whitespace-pre-wrap break-all bg-muted/50 rounded-md p-2 max-h-40 overflow-auto font-mono'>
        {value}
      </pre>
    </div>
  )
}

function NodeRow({ nodeId }: { nodeId: string }) {
  const canvas = useCanvasNodes()
  const node = canvas?.getNode(nodeId) as { data?: { name?: string } } | undefined
  const name = node?.data?.name
  const value = name ? `${name} (${nodeId})` : nodeId
  return <FieldRow label='Node' value={value} />
}

function TargetRow({ target }: { target: string }) {
  const canvas = useCanvasNodes()
  const [nodeId, handleId] = target.split('/')
  const node = canvas?.getNode(nodeId) as { data?: { name?: string } } | undefined
  const name = node?.data?.name
  const label = name ? `${name} (${nodeId})` : nodeId
  const value = handleId ? `${label} / ${handleId}` : label
  return <FieldRow label='Target' value={value} />
}

// Replace `from` with `to` in `text` — once, or every occurrence when
// replaceAll. Reused in both directions: forward to compute what an edit
// produces (approval mode), or with `from`/`to` swapped to reconstruct what it
// started from (history mode, working back from the already-applied result).
function substitute(text: string, from: string, to: string, replaceAll: boolean): string {
  return replaceAll ? text.split(from).join(to) : text.replace(from, to)
}

function useRemoteFileContent(
  target: string | undefined,
  space: string | undefined,
  path: string | undefined,
  requestId: string,
) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies(requestId): re-read the file for every new approval request
  useEffect(() => {
    if (!target || !path) {
      return
    }
    let cancelled = false
    setContent(null)
    setError(null)
    readRemoteFile({ data: { target, space, path } })
      .then((value) => {
        if (!cancelled) {
          setContent(value)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message)
          setContent('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [target, space, path, requestId])

  return { content, error }
}

// Approval mode projects the diff into the canvas overlay panel (there's one
// shared slot, and the approval list only shows a summary inline). History
// mode has no such slot available — the chat transcript itself already lives
// there — so it renders the same diff inline instead.
function ToolDiffPanel({
  mode,
  label,
  current,
  next,
}: {
  mode: ToolViewProps['mode']
  label?: string
  current: string | null
  next: string
}) {
  const diffNode = useMemo(() => {
    if (current === null) {
      return null
    }
    return (
      <div className='p-4'>
        <NodeCard className='w-full'>
          <div className='px-3 py-2 space-y-2'>
            {label && <div className='font-mono text-xs'>{label}</div>}
            <CanvasSafeDiffEditor current={current} next={next} />
          </div>
        </NodeCard>
      </div>
    )
  }, [current, next, label])

  useOptionalOverlay(mode === 'approval' ? { content: diffNode } : undefined)

  return mode === 'history' ? diffNode : null
}

// For whole-overwrite tools, the "before" state is gone once the call has
// executed — there's nothing left to diff against. History mode shows the
// resulting content on its own instead of fabricating a diff.
function ToolContentPanel({ mode, label, content }: { mode: ToolViewProps['mode']; label?: string; content: string }) {
  if (mode !== 'history') {
    return null
  }
  return (
    <div className='p-4'>
      <NodeCard className='w-full'>
        <div className='px-3 py-2 space-y-2'>
          {label && <div className='font-mono text-xs'>{label}</div>}
          <pre className='text-xs whitespace-pre-wrap break-all bg-muted/50 rounded-md p-2 max-h-72 overflow-auto font-mono'>
            {content}
          </pre>
        </div>
      </NodeCard>
    </div>
  )
}

function RemoteReadView({ args, mode, result }: ToolViewProps) {
  const target = args.target as string | undefined
  const filePath = args.path as string | undefined

  if (mode === 'approval') {
    return (
      <div className='space-y-3 px-3 py-2'>
        {target && <TargetRow target={target} />}
        {filePath && <FieldRow label='Path' value={filePath} />}
      </div>
    )
  }

  return (
    <OpBlock
      verb='Read'
      detail={filePath}
      target={target}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(result?.text)}
    >
      <OpRow label='output'>
        {result ? (
          result.text ? (
            <pre className='m-0 whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>{result.text}</pre>
          ) : (
            <span className='text-muted-foreground'>No output</span>
          )
        ) : (
          <Flex row align='center' className='gap-1.5 text-muted-foreground'>
            <Loader2 className='size-3 animate-spin' />
            <span>running…</span>
          </Flex>
        )}
      </OpRow>
    </OpBlock>
  )
}

function RemoteWriteView({ args, requestId, mode, result }: ToolViewProps) {
  const target = args.target as string | undefined
  const space = args.space as string | undefined
  const filePath = args.path as string | undefined
  const newContent = (args.content as string | undefined) ?? ''
  // History mode already has the full new content in `args` — no live read
  // needed (and by now the file already reflects it, so refetching would only
  // reproduce `newContent`, not the state before the write).
  const { content, error } = useRemoteFileContent(mode === 'approval' ? target : undefined, space, filePath, requestId)

  if (mode === 'approval') {
    return (
      <div className='space-y-3 px-3 py-2'>
        {target && <TargetRow target={target} />}
        {filePath && <FieldRow label='Path' value={filePath} />}
        {error && <FieldRow label='Note' value={`Could not read existing file: ${error}`} />}
        {content === null && <div className='text-xs text-muted-foreground'>Loading current content…</div>}
        <ToolDiffPanel mode={mode} label={filePath} current={content} next={newContent} />
      </div>
    )
  }

  // Whole-overwrite: the prior content is gone once the write has executed —
  // show the resulting content on its own rather than a fabricated diff.
  return (
    <OpBlock
      verb='Write'
      detail={filePath}
      target={target}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(newContent)}
    >
      <OpRow label='content'>
        <pre className='m-0 whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>{newContent}</pre>
      </OpRow>
    </OpBlock>
  )
}

function RemoteEditView({ args, requestId, mode, result }: ToolViewProps) {
  const target = args.target as string | undefined
  const space = args.space as string | undefined
  const filePath = args.path as string | undefined
  const oldString = (args.oldString as string | undefined) ?? ''
  const newString = (args.newString as string | undefined) ?? ''
  const replaceAll = Boolean(args.replaceAll)
  // Approval: `live` is the file before the edit. History: the edit already
  // ran, so `live` is the file after — reconstruct "before" by substituting
  // in reverse (new -> old) instead of forward (old -> new).
  const { content: live, error } = useRemoteFileContent(target, space, filePath, requestId)

  const current = live === null ? null : mode === 'approval' ? live : substitute(live, newString, oldString, replaceAll)
  const next = live === null ? '' : mode === 'approval' ? substitute(live, oldString, newString, replaceAll) : live

  if (mode === 'approval') {
    return (
      <div className='space-y-3 px-3 py-2'>
        {target && <TargetRow target={target} />}
        {filePath && <FieldRow label='Path' value={filePath} />}
        <FieldRow label='Old' value={oldString} />
        <FieldRow label='New' value={newString} />
        {replaceAll && <div className='text-xs text-muted-foreground'>Replace all occurrences</div>}
        {error && <FieldRow label='Note' value={`Could not read existing file: ${error}`} />}
        {live === null && <div className='text-xs text-muted-foreground'>Loading current content…</div>}
        <ToolDiffPanel mode={mode} label={filePath} current={current} next={next} />
      </div>
    )
  }

  return (
    <OpBlock
      verb='Edit'
      detail={filePath}
      target={target}
      isError={result?.isError}
      pending={!result}
      overflowing={current !== null}
    >
      {current !== null && <CanvasSafeDiffEditor current={current} next={next} />}
    </OpBlock>
  )
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function usePropertyLabel(nodeId: string | undefined, path: string | undefined): string | undefined {
  const canvas = useCanvasNodes()
  if (!nodeId || !path) {
    return undefined
  }
  const node = canvas?.getNode(nodeId) as { data?: { name?: string } } | undefined
  const name = node?.data?.name ?? nodeId
  return `${name} (${nodeId}) · ${path}`
}

function useLiveProperty(nodeId: string | undefined, path: string | undefined): string {
  const canvas = useCanvasNodes()
  const node = nodeId ? (canvas?.getNode(nodeId) as { data?: Record<string, unknown> } | undefined) : undefined
  const raw = node && path ? getByPath(node.data ?? {}, path) : undefined
  return typeof raw === 'string' ? raw : ''
}

function WriteNodePropertyView({ args, mode }: ToolViewProps) {
  const nodeId = args.nodeId as string | undefined
  const propPath = args.path as string | undefined
  const value = (args.value as string | undefined) ?? ''
  // History: the property already holds `value` — nothing to diff against.
  const label = usePropertyLabel(nodeId, propPath)
  const live = useLiveProperty(mode === 'approval' ? nodeId : undefined, propPath)

  return (
    <div className='space-y-3 px-3 py-2'>
      {nodeId && <NodeRow nodeId={nodeId} />}
      {propPath && <FieldRow label='Path' value={propPath} />}
      {nodeId && propPath && (
        <>
          <ToolDiffPanel mode={mode} label={label} current={mode === 'approval' ? live : null} next={value} />
          <ToolContentPanel mode={mode} label={label} content={value} />
        </>
      )}
    </div>
  )
}

function EditNodePropertyView({ args, mode }: ToolViewProps) {
  const nodeId = args.nodeId as string | undefined
  const propPath = args.path as string | undefined
  const oldString = (args.oldString as string | undefined) ?? ''
  const newString = (args.newString as string | undefined) ?? ''
  const replaceAll = Boolean(args.replaceAll)
  const label = usePropertyLabel(nodeId, propPath)
  // Approval: the live property is the value before the edit. History: it's
  // already the edited value — reconstruct "before" in reverse, same trick as
  // RemoteEditView.
  const live = useLiveProperty(nodeId, propPath)
  const current = mode === 'approval' ? live : substitute(live, newString, oldString, replaceAll)
  const next = mode === 'approval' ? substitute(live, oldString, newString, replaceAll) : live

  return (
    <div className='space-y-3 px-3 py-2'>
      {nodeId && <NodeRow nodeId={nodeId} />}
      {propPath && <FieldRow label='Path' value={propPath} />}
      <FieldRow label='Old' value={oldString} />
      <FieldRow label='New' value={newString} />
      {replaceAll && <div className='text-xs text-muted-foreground'>Replace all occurrences</div>}
      {nodeId && propPath && <ToolDiffPanel mode={mode} label={label} current={current} next={next} />}
    </div>
  )
}

// Shared expanded body for Exec/Script: an input row (command/script text)
// and an output row (the result), mirroring agent-chat's ToolCallBlock —
// including its "running…" spinner while the call hasn't resolved yet.
function OpInputOutput({ input, result }: { input?: string; result?: ToolViewProps['result'] }) {
  return (
    <>
      {input && (
        <OpRow label='input'>
          <pre className='m-0 whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>{input}</pre>
        </OpRow>
      )}
      <div className='border-t' />
      <OpRow label='output'>
        {result ? (
          result.text ? (
            <pre className='m-0 whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>{result.text}</pre>
          ) : (
            <span className='text-muted-foreground'>No output</span>
          )
        ) : (
          <Flex row align='center' className='gap-1.5 text-muted-foreground'>
            <Loader2 className='size-3 animate-spin' />
            <span>running…</span>
          </Flex>
        )}
      </OpRow>
    </>
  )
}

// Fallback for a tool call with no registered view (e.g. an external MCP
// server's tool) — same chrome as Exec/Script (bold name, input/output rows,
// clamped preview, view-full dialog), just without a target line: a generic
// tool call isn't tied to one of our node/handle targets.
export function GenericToolView({
  tool,
  args,
  result,
}: {
  tool: string
  args: Record<string, unknown>
  result?: ToolViewProps['result']
}) {
  const argsText = Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : undefined
  return (
    <OpBlock
      verb={tool}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(argsText) || exceedsClamp(result?.text)}
    >
      <OpInputOutput input={argsText} result={result} />
    </OpBlock>
  )
}

function RemoteExecView({ args, mode, result }: ToolViewProps) {
  const target = args.target as string | undefined
  const command = args.command as string | undefined
  const secrets = args.secrets as string[] | undefined
  const description = args.description as string | undefined

  if (mode === 'approval') {
    return (
      <div className='space-y-3 px-3 py-2'>
        {target && <TargetRow target={target} />}
        {description && <FieldRow label='Description' value={description} />}
        {command && <FieldRow label='Command' value={command} />}
        {secrets && secrets.length > 0 && <FieldRow label='Secrets' value={secrets.join(', ')} />}
      </div>
    )
  }

  return (
    <OpBlock
      verb='Exec'
      detail={description}
      target={target}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(command) || exceedsClamp(result?.text)}
    >
      <OpInputOutput input={command} result={result} />
    </OpBlock>
  )
}

function RemoteScriptView({ args, mode, result }: ToolViewProps) {
  const target = args.target as string | undefined
  const script = args.script as string | undefined
  const scriptArgs = args.args as string[] | undefined
  const secrets = args.secrets as string[] | undefined
  const description = args.description as string | undefined

  if (mode === 'approval') {
    return (
      <div className='space-y-3 px-3 py-2'>
        {target && <TargetRow target={target} />}
        {description && <FieldRow label='Description' value={description} />}
        {script && <FieldRow label='Script' value={script} />}
        {scriptArgs && scriptArgs.length > 0 && <FieldRow label='Args' value={scriptArgs.join(' ')} />}
        {secrets && secrets.length > 0 && <FieldRow label='Secrets' value={secrets.join(', ')} />}
      </div>
    )
  }

  return (
    <OpBlock
      verb='Script'
      detail={description}
      target={target}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(script) || exceedsClamp(result?.text)}
    >
      <OpInputOutput input={script} result={result} />
    </OpBlock>
  )
}

function useSkillBody(name: string | undefined, requestId: string) {
  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies(requestId): re-read the skill for every new approval request
  useEffect(() => {
    if (!name) {
      return
    }
    let cancelled = false
    setBody(null)
    setError(null)
    fetch('/api/acp/skills')
      .then((r) => r.json())
      .then((skills: { name: string; body: string }[]) => {
        if (cancelled) {
          return
        }
        const found = skills.find((skill) => skill.name === name)
        setBody(found ? found.body : '')
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message)
          setBody('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [name, requestId])

  return { body, error }
}

function SkillWriteView({ args, requestId, mode }: ToolViewProps) {
  const name = args.name as string | undefined
  const description = args.description as string | undefined
  const newBody = (args.body as string | undefined) ?? ''
  const { body, error } = useSkillBody(mode === 'approval' ? name : undefined, requestId)

  return (
    <div className='space-y-3 px-3 py-2'>
      {name && <FieldRow label='Skill' value={name} />}
      {description && <FieldRow label='Description' value={description} />}
      {mode === 'approval' && error && <FieldRow label='Note' value={`Could not read existing skill: ${error}`} />}
      {mode === 'approval' && body === null && (
        <div className='text-xs text-muted-foreground'>Loading current skill…</div>
      )}
      <ToolDiffPanel mode={mode} label={name} current={body} next={newBody} />
      <ToolContentPanel mode={mode} label={name} content={newBody} />
    </div>
  )
}

function SkillEditView({ args, requestId, mode }: ToolViewProps) {
  const name = args.name as string | undefined
  const oldString = (args.oldString as string | undefined) ?? ''
  const newString = (args.newString as string | undefined) ?? ''
  const replaceAll = Boolean(args.replaceAll)
  const { body: live, error } = useSkillBody(name, requestId)

  const current = live === null ? null : mode === 'approval' ? live : substitute(live, newString, oldString, replaceAll)
  const next = live === null ? '' : mode === 'approval' ? substitute(live, oldString, newString, replaceAll) : live

  return (
    <div className='space-y-3 px-3 py-2'>
      {name && <FieldRow label='Skill' value={name} />}
      <FieldRow label='Old' value={oldString} />
      <FieldRow label='New' value={newString} />
      {replaceAll && <div className='text-xs text-muted-foreground'>Replace all occurrences</div>}
      {error && <FieldRow label='Note' value={`Could not read existing skill: ${error}`} />}
      {live === null && <div className='text-xs text-muted-foreground'>Loading current skill…</div>}
      <ToolDiffPanel mode={mode} label={name} current={current} next={next} />
    </div>
  )
}

function CallView({ args, mode, result }: ToolViewProps) {
  const nodeId = args.nodeId as string | undefined
  const action = args.action as string | undefined
  const params = args.params as Record<string, unknown> | undefined
  const paramsText = params && Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : null

  if (mode === 'approval') {
    return (
      <div className='space-y-3 px-3 py-2'>
        {nodeId && <NodeRow nodeId={nodeId} />}
        {action && <FieldRow label='Action' value={action} />}
        {paramsText && <FieldRow label='Params' value={paramsText} />}
      </div>
    )
  }

  return (
    <OpBlock
      verb='Call'
      detail={action}
      target={nodeId}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(paramsText ?? undefined) || exceedsClamp(result?.text)}
    >
      {paramsText && (
        <OpRow label='params'>
          <pre className='m-0 whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>{paramsText}</pre>
        </OpRow>
      )}
      <div className='border-t' />
      <OpRow label='output'>
        {result ? (
          <pre className='m-0 whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>{result.text}</pre>
        ) : (
          <span className='text-muted-foreground'>No output</span>
        )}
      </OpRow>
    </OpBlock>
  )
}

interface NodeUpdate {
  nodeId: string
  data?: Record<string, unknown>
  position?: { x: number; y: number }
}

function changeSummary(update: NodeUpdate): string {
  const parts: string[] = []
  if (update.data && Object.keys(update.data).length > 0) {
    parts.push(`data: ${Object.keys(update.data).join(', ')}`)
  }
  if (update.position) {
    parts.push('position')
  }
  return parts.join(' · ') || 'no changes'
}

function NodeDiff({ mode, update }: { mode: ToolViewProps['mode']; update: NodeUpdate }) {
  const canvas = useCanvasNodes()
  const node = canvas?.getNode(update.nodeId) as
    | { data?: Record<string, unknown>; position?: { x: number; y: number } }
    | undefined
  const name = (node?.data?.name as string | undefined) ?? update.nodeId
  const label = `${name} (${update.nodeId})`
  const next = {
    ...(update.data ? { data: { ...(node?.data ?? {}), ...update.data } } : {}),
    ...(update.position ? { position: update.position } : {}),
  }

  // History: the node already reflects `next` — nothing left to diff against.
  if (mode === 'history') {
    return <ToolContentPanel mode={mode} label={label} content={JSON.stringify(next, null, 2)} />
  }
  const current = {
    ...(update.data ? { data: node?.data ?? {} } : {}),
    ...(update.position ? { position: node?.position } : {}),
  }
  return (
    <div className='px-3 py-2 space-y-2'>
      <div className='font-mono text-xs'>{label}</div>
      <CanvasSafeDiffEditor current={JSON.stringify(current, null, 2)} next={JSON.stringify(next, null, 2)} />
    </div>
  )
}

function UpdateNodesView({ args, requestId, mode }: ToolViewProps) {
  const updates = (args.updates ?? []) as NodeUpdate[]
  const canvas = useCanvasNodes()
  const [openId, setOpenId] = useState<string | null>(null)

  const openUpdate = openId ? (updates.find((u) => u.nodeId === openId) ?? null) : null
  const diffNode = useMemo(() => {
    if (!openUpdate || mode !== 'approval') {
      return null
    }
    return (
      <div className='p-4'>
        <NodeCard className='w-full'>
          <NodeDiff mode={mode} update={openUpdate} />
        </NodeCard>
      </div>
    )
  }, [openUpdate, mode])

  useOptionalOverlay(mode === 'approval' ? { content: diffNode } : undefined)

  // biome-ignore lint/correctness/useExhaustiveDependencies(requestId): collapse the open diff when a new request arrives
  useEffect(() => {
    setOpenId(null)
  }, [requestId])

  if (!updates.length) {
    return <div className='px-3 py-2 text-xs text-muted-foreground'>No updates.</div>
  }

  return (
    <div className='space-y-1.5 px-3 py-2'>
      <div className='text-xs font-medium text-muted-foreground'>
        {updates.length} node{updates.length === 1 ? '' : 's'} to update
      </div>
      <div className='space-y-1'>
        {updates.map((update) => {
          const node = canvas?.getNode(update.nodeId) as { data?: { name?: string } } | undefined
          const name = node?.data?.name ?? update.nodeId
          const active = openId === update.nodeId
          return (
            <div key={update.nodeId} className='space-y-1'>
              <Button
                variant='outline'
                size='sm'
                className={cn('justify-start w-full font-normal', active && 'border-primary ring-1 ring-primary/40')}
                onClick={() => setOpenId(active ? null : update.nodeId)}
              >
                <GitCompare />
                <span className='min-w-0 flex-1 truncate text-left'>{name}</span>
                <span className='min-w-0 shrink truncate text-[10px] text-muted-foreground'>
                  {changeSummary(update)}
                </span>
              </Button>
              {mode === 'history' && active && <NodeDiff mode={mode} update={update} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

registerToolView('remote_read', {
  body: RemoteReadView,
  getNodeId: (args) => (args.target as string | undefined)?.split('/')[0],
})

registerToolView('remote_exec', {
  body: RemoteExecView,
  getNodeId: (args) => (args.target as string | undefined)?.split('/')[0],
})

registerToolView('remote_script', {
  body: RemoteScriptView,
  getNodeId: (args) => (args.target as string | undefined)?.split('/')[0],
})

registerToolView('remote_write', {
  body: RemoteWriteView,
  getNodeId: (args) => (args.target as string | undefined)?.split('/')[0],
})

registerToolView('remote_edit', {
  body: RemoteEditView,
  getNodeId: (args) => (args.target as string | undefined)?.split('/')[0],
})

registerToolView('skill_write', {
  body: SkillWriteView,
})

registerToolView('skill_edit', {
  body: SkillEditView,
})

registerToolView('call', {
  body: CallView,
  getNodeId: (args) => args.nodeId as string | undefined,
})

registerToolView('update_nodes', {
  body: UpdateNodesView,
})

registerToolView('write_node_property', {
  body: WriteNodePropertyView,
  getNodeId: (args) => args.nodeId as string | undefined,
})

registerToolView('edit_node_property', {
  body: EditNodePropertyView,
  getNodeId: (args) => args.nodeId as string | undefined,
})
