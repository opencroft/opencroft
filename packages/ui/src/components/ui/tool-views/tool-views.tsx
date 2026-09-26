'use client'

import { normalizeToolId, type ToolViewProps } from 'agent-chat/tool-views'
import { GitCompare, Loader2 } from 'lucide-react'
import { type ComponentType, useEffect, useMemo, useState } from 'react'

import { Button } from '../button'
import { Flex } from 'ui/components/ui/layout/flex'
import { NodeCard } from '../nodes/node-card'
import { cn } from 'ui/lib/utils'
import { exceedsClamp, OpBlock, OpRow } from './op-block'
import { useToolViewHost } from './tool-view-host'

// A rich, tool-specific view of a tool call — shared by the approval prompt
// (before the call runs) and the chat transcript (after it ran). `mode` tells a
// view which side of the call it's rendering: 'approval' has live pre-call
// state to diff against args; 'history' only has post-call live state, so a
// view that wants a diff must reconstruct the "before" side from args instead
// (see the substitution-based views below).
//
// Everything a view needs from the product it runs in comes through
// useToolViewHost(). No view reads a canvas, an overlay or a store directly.
export interface ToolViewSpec {
  body: ComponentType<ToolViewProps>
  getNodeId?: (args: Record<string, unknown>) => string | undefined
}

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
  const { canvas } = useToolViewHost()
  const name = canvas?.getNode(nodeId)?.data?.name as string | undefined
  const value = name ? `${name} (${nodeId})` : nodeId
  return <FieldRow label='Node' value={value} />
}

function TargetRow({ target }: { target: string }) {
  const { canvas } = useToolViewHost()
  const [nodeId, handleId] = target.split('/')
  const name = canvas?.getNode(nodeId)?.data?.name as string | undefined
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
  const { readFile } = useToolViewHost()
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
    readFile({ target, space, path })
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
  }, [readFile, target, space, path, requestId])

  return { content, error }
}

// Approval mode projects the diff into the host's approval panel (there's one
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
  const { DiffEditor, ApprovalPanel } = useToolViewHost()
  const diffNode = useMemo(() => {
    if (current === null) {
      return null
    }
    return (
      <div className='p-4'>
        <NodeCard className='w-full'>
          <div className='px-3 py-2 space-y-2'>
            {label && <div className='font-mono text-xs'>{label}</div>}
            <DiffEditor original={current} value={next} path={label} />
          </div>
        </NodeCard>
      </div>
    )
  }, [DiffEditor, current, next, label])

  if (mode === 'history') {
    return diffNode
  }
  return ApprovalPanel ? <ApprovalPanel>{diffNode}</ApprovalPanel> : null
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

// ── the agent's own file tools ─────────────────────────────────────────────
//
// The remote views below are for the product's own MCP tools, which act on a
// remote node and so have a `target` and can read the file back over it. An
// agent's own Write/Edit act on the machine its harness runs on, which the host
// has no handle for — so these render from the call's arguments alone. That is
// also what makes them behave identically on a reopened conversation: the
// arguments are in the transcript, where a live read would have nothing to read
// from.
//
// The harness sends a rendered diff of its own alongside the call, and it is
// deliberately not used: for a Write it describes the file as newly created
// even when the call overwrote one, because the correction to that arrives in a
// hook the harness does not run when it replays history (measured against
// claude-agent-acp 0.78.0). Reading the arguments gives the same answer live
// and replayed, rather than a better one live and a misleading one after a
// reload.

const agentFilePath = (args: Record<string, unknown>) => args.file_path as string | undefined

// A whole-file write. The prior contents are not in the call and not reachable
// from here, so there is nothing to diff against — the resulting file is shown
// on its own, which is what ToolContentPanel exists for.
function AgentWriteView({ args, mode, result }: ToolViewProps) {
  const filePath = agentFilePath(args)
  const content = (args.content as string | undefined) ?? ''

  if (mode === 'approval') {
    return (
      <div className='space-y-3 px-3 py-2'>
        {filePath && <FieldRow label='Path' value={filePath} />}
        <ToolContentPanel mode='history' label={filePath} content={content} />
      </div>
    )
  }

  return (
    <OpBlock
      verb='Write'
      detail={filePath}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(content)}
    >
      <OpRow label='content'>
        <pre className='m-0 whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>{content}</pre>
      </OpRow>
    </OpBlock>
  )
}

// A targeted replacement, which is the case that genuinely has two sides: the
// call carries both, so the diff is exact rather than reconstructed — unlike
// the remote-file views, which have to substitute in reverse against the file
// as it is now.
function AgentEditView({ args, mode, result }: ToolViewProps) {
  const filePath = agentFilePath(args)
  const oldString = (args.old_string as string | undefined) ?? ''
  const newString = (args.new_string as string | undefined) ?? ''

  const body = (
    <div className='space-y-3 px-3 py-2'>
      {filePath && <FieldRow label='Path' value={filePath} />}
      <ToolDiffPanel mode='history' label={filePath} current={oldString} next={newString} />
    </div>
  )

  if (mode === 'approval') {
    return body
  }

  return (
    <OpBlock
      verb='Edit'
      detail={filePath}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(newString)}
    >
      <OpRow label='diff'>{body}</OpRow>
    </OpBlock>
  )
}

// Several replacements in one file. Each is its own before/after pair, so they
// are drawn as a list of diffs rather than merged — a merged one would have to
// invent a combined "before" that never existed.
function AgentMultiEditView({ args, mode, result }: ToolViewProps) {
  const filePath = agentFilePath(args)
  const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : []

  const body = (
    <div className='space-y-3 px-3 py-2'>
      {filePath && <FieldRow label='Path' value={filePath} />}
      {edits.map((edit, index) => (
        <ToolDiffPanel
          // Position IS the identity here: an edits list is ordered, applied in
          // order, and has no id of its own — two identical replacements in one
          // call are different edits.
          // biome-ignore lint/suspicious/noArrayIndexKey: an edit's position in the list is its identity
          key={index}
          mode='history'
          label={`${index + 1} of ${edits.length}`}
          current={(edit.old_string as string | undefined) ?? ''}
          next={(edit.new_string as string | undefined) ?? ''}
        />
      ))}
    </div>
  )

  if (mode === 'approval') {
    return body
  }

  return (
    <OpBlock verb='Edit' detail={filePath} isError={result?.isError} pending={!result}>
      <OpRow label={edits.length === 1 ? '1 edit' : `${edits.length} edits`}>{body}</OpRow>
    </OpBlock>
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
  const { DiffEditor } = useToolViewHost()
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
      {current !== null && <DiffEditor original={current} value={next} path={filePath} />}
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
  const { canvas } = useToolViewHost()
  if (!nodeId || !path) {
    return undefined
  }
  const name = (canvas?.getNode(nodeId)?.data?.name as string | undefined) ?? nodeId
  return `${name} (${nodeId}) · ${path}`
}

function useLiveProperty(nodeId: string | undefined, path: string | undefined): string {
  const { canvas } = useToolViewHost()
  const node = nodeId ? canvas?.getNode(nodeId) : undefined
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
// tool call isn't tied to one of the product's node/handle targets.
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
  const { describeBackgroundRun } = useToolViewHost()
  const target = args.target as string | undefined
  const command = args.command as string | undefined
  const secrets = args.secrets as string[] | undefined
  const description = args.description as string | undefined
  // Said before approval, not after: a detached command outlives this call.
  const runs = describeBackgroundRun(args)

  if (mode === 'approval') {
    return (
      <div className='space-y-3 px-3 py-2'>
        {target && <TargetRow target={target} />}
        {description && <FieldRow label='Description' value={description} />}
        {command && <FieldRow label='Command' value={command} />}
        {runs && <FieldRow label='Runs' value={runs} />}
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
  const { describeBackgroundRun } = useToolViewHost()
  const target = args.target as string | undefined
  const script = args.script as string | undefined
  const scriptArgs = args.args as string[] | undefined
  const secrets = args.secrets as string[] | undefined
  const description = args.description as string | undefined
  const runs = describeBackgroundRun(args)

  if (mode === 'approval') {
    return (
      <div className='space-y-3 px-3 py-2'>
        {target && <TargetRow target={target} />}
        {description && <FieldRow label='Description' value={description} />}
        {script && <FieldRow label='Script' value={script} />}
        {scriptArgs && scriptArgs.length > 0 && <FieldRow label='Args' value={scriptArgs.join(' ')} />}
        {runs && <FieldRow label='Runs' value={runs} />}
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
  const { readSkill } = useToolViewHost()
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
    readSkill(name)
      .then((value) => {
        if (!cancelled) {
          setBody(value)
        }
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
  }, [readSkill, name, requestId])

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
  const { canvas, DiffEditor } = useToolViewHost()
  const node = canvas?.getNode(update.nodeId)
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
      <DiffEditor
        original={JSON.stringify(current, null, 2)}
        value={JSON.stringify(next, null, 2)}
        language='json'
      />
    </div>
  )
}

function UpdateNodesView({ args, requestId, mode }: ToolViewProps) {
  const { canvas, ApprovalPanel } = useToolViewHost()
  const updates = (args.updates ?? []) as NodeUpdate[]
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

  // Rendered on both returns below, so the panel is written whichever one
  // this render takes — the same slot write the view made before it had a host.
  const panel = mode === 'approval' && ApprovalPanel ? <ApprovalPanel>{diffNode}</ApprovalPanel> : null

  // biome-ignore lint/correctness/useExhaustiveDependencies(requestId): collapse the open diff when a new request arrives
  useEffect(() => {
    setOpenId(null)
  }, [requestId])

  if (!updates.length) {
    return (
      <>
        {panel}
        <div className='px-3 py-2 text-xs text-muted-foreground'>No updates.</div>
      </>
    )
  }

  return (
    <div className='space-y-1.5 px-3 py-2'>
      {panel}
      <div className='text-xs font-medium text-muted-foreground'>
        {updates.length} node{updates.length === 1 ? '' : 's'} to update
      </div>
      <div className='space-y-1'>
        {updates.map((update) => {
          const name = (canvas?.getNode(update.nodeId)?.data?.name as string | undefined) ?? update.nodeId
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

function formatArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, null, 2)
}

// The approval list's fallback: every call has to show something before it is
// approved, and a tool with no view of its own shows its raw arguments.
export function DefaultToolView({ args }: ToolViewProps) {
  return (
    <div className='space-y-1 px-3 py-2'>
      <div className='text-xs font-medium text-muted-foreground'>Arguments</div>
      <pre className='text-xs whitespace-pre-wrap break-all bg-muted/50 rounded-md p-2 max-h-72 overflow-auto font-mono'>
        {formatArgs(args)}
      </pre>
    </div>
  )
}

const DEFAULT_SPEC: ToolViewSpec = { body: DefaultToolView }

const targetNodeId = (args: Record<string, unknown>) => (args.target as string | undefined)?.split('/')[0]
const argNodeId = (args: Record<string, unknown>) => args.nodeId as string | undefined

// ── app_call ────────────────────────────────────────────────────────────
//
// The three graph writes above (updateNodes, writeNodeProperty,
// editNodeProperty) run through app_call, so the transcript's programmatic
// name for all of them is 'app_call' — only `args.action` tells them apart.
// An approval arrives keyed by the server's own `view` ('graph.updateNodes',
// …) but with the same app_call args, `{ app, action, params }`, so those
// keys resolve to the very same spec: one view that peels `params` off for
// the inner graph view, whichever way a caller arrived. GRAPH_ACTION_VIEWS is
// the single place a graph action's view and its params shape are declared. Matching checks the
// params shape, not just the action id, because an extension App can declare
// an action with the same id as one of the graph's — an id match alone would
// let an unrelated call borrow the graph's view.
interface GraphActionSpec {
  view: ToolViewSpec
  matches: (params: Record<string, unknown>) => boolean
}

const GRAPH_ACTION_VIEWS: Readonly<Record<string, GraphActionSpec>> = {
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
  const graphAction = GRAPH_ACTION_VIEWS[action]
  if (!graphAction || !graphAction.matches(params as Record<string, unknown>)) {
    return undefined
  }
  return { view: graphAction.view, params: params as Record<string, unknown> }
}

// The transcript's entry for every app_call, whichever action it carries:
// render the graph's own view when the action and its params match one,
// otherwise fall back exactly as an unregistered tool would.
function AppCallView(props: ToolViewProps) {
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

function appCallNodeId(args: Record<string, unknown>): string | undefined {
  const resolved = appActionView(args)
  return resolved && resolved.view.getNodeId?.(resolved.params)
}

const APP_CALL_SPEC: ToolViewSpec = { body: AppCallView, getNodeId: appCallNodeId }

// Every view, keyed by the tool's programmatic name. The agent's own file tools
// are keyed the same way, which is what the transcript matches on — their
// displayed titles embed the file path, so no fixed id could ever equal one.
// `getNodeId` names the node a call acts on, for a host that offers to show it.
export const TOOL_VIEWS: Readonly<Record<string, ToolViewSpec>> = {
  Write: { body: AgentWriteView },
  Edit: { body: AgentEditView },
  MultiEdit: { body: AgentMultiEditView },
  remote_read: { body: RemoteReadView, getNodeId: targetNodeId },
  remote_exec: { body: RemoteExecView, getNodeId: targetNodeId },
  remote_script: { body: RemoteScriptView, getNodeId: targetNodeId },
  remote_write: { body: RemoteWriteView, getNodeId: targetNodeId },
  remote_edit: { body: RemoteEditView, getNodeId: targetNodeId },
  skill_write: { body: SkillWriteView },
  skill_edit: { body: SkillEditView },
  call: { body: CallView, getNodeId: argNodeId },
  'graph.updateNodes': APP_CALL_SPEC,
  'graph.writeNodeProperty': APP_CALL_SPEC,
  'graph.editNodeProperty': APP_CALL_SPEC,
  app_call: APP_CALL_SPEC,
}

// Only a specifically registered view, or undefined — for callers (the chat
// transcript) that already have a reasonable default of their own to fall back
// to instead of the raw-args dump. The id is normalized first, so a tool
// reported with an MCP server prefix still finds its view. Own keys only: a
// tool that happens to be called `toString` or `constructor` must find nothing
// rather than something inherited from Object.
export function lookupToolView(id: string): ToolViewSpec | undefined {
  const key = normalizeToolId(id)
  return Object.hasOwn(TOOL_VIEWS, key) ? TOOL_VIEWS[key] : undefined
}

// Always returns a spec, falling back to the raw-args dump — for callers (the
// approval prompt) that must render something regardless of whether a rich
// view is registered.
export function resolveToolView(id?: string): ToolViewSpec {
  if (!id) {
    return DEFAULT_SPEC
  }
  return lookupToolView(id) ?? DEFAULT_SPEC
}
