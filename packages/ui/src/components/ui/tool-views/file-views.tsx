'use client'

import type { ToolViewProps } from 'agent-chat/tool-views'
import { useMemo } from 'react'

import { ApprovalDiff, ApprovalFields, FieldRow, Note, TargetRow } from './approval-fields'
import { type DiffLine, lineDiff } from './diff-view'
import { editSides, textEdit, useRemoteFile } from './edit-sides'
import { DiffOpBlock, exceedsClamp, linesLabel, OpBlock, OpMeta, OpOutput, OpRow } from './op-block'

// Views of calls that read and write files: the agent's own Write, Edit and
// MultiEdit, and the product's remote_read, remote_write and remote_edit.
//
// The agent's own tools act on the machine its harness runs on, which the host
// has no handle for — so those views render from what the call itself carries.
// That is also what makes them behave the same on a reopened conversation: the
// call is in the transcript, where a live read would have nothing to read from.
//
// The change itself comes first from the diffs the harness reported with the
// call, and from the call's arguments only when it reported none. The order is
// not a preference: claude-agent-acp 0.84.0 leaves the replaced and the written
// text out of the arguments for a client that declares the JetBrains AIR
// extension, so for an Edit or a Write the reported diff is the only copy of
// the change. A harness that reports nothing — and a transcript recorded before
// diffs were kept — still has its arguments.
//
// The remote tools act on a node and have a `target`, so their views can read
// the file back over it.

const agentFilePath = (args: Record<string, unknown>) => args.file_path as string | undefined

// What a call reported of its change, or null when it reported nothing: one
// diff per region it named (a whole file, or one hunk of it).
//
// A region without a before side (`oldText` null) is diffed against nothing,
// every line added, which is what ACP means by it: a created file. A harness
// may send the same for an overwrite whose prior content it did not read —
// claude-agent-acp 0.84.0 does for every Write until its post-write hook
// reports the real diff, and a replayed session never runs that hook — and
// such an overwrite then reads as a created file.
function reportedChange(diffs: ToolViewProps['diffs']): DiffLine[][] | null {
  return diffs?.length ? diffs.map((diff) => lineDiff(diff.oldText ?? '', diff.newText)) : null
}

// An agent edit's diffs: the reported ones, or the ones its arguments spell
// out. `part` is what each one is, for the heading over several.
function agentEditDiffs(
  reported: ToolViewProps['diffs'],
  fromArgs: () => DiffLine[][],
): { diffs: DiffLine[][]; part: string } {
  const diffs = reportedChange(reported)
  return diffs ? { diffs, part: 'Change' } : { diffs: fromArgs(), part: 'Edit' }
}

// The approval form of the same: one diff under the file's path, several under
// "<part> n of m".
function ApprovalDiffs({ path, diffs, part }: { path?: string; diffs: DiffLine[][]; part: string }) {
  if (diffs.length === 0) {
    return <Note>The change is not in the request.</Note>
  }
  return diffs.map((diff, index) => (
    <ApprovalDiff
      // biome-ignore lint/suspicious/noArrayIndexKey: a diff's position in the list is its identity
      key={index}
      label={diffs.length > 1 ? `${part} ${index + 1} of ${diffs.length}` : path}
      diff={diff}
    />
  ))
}

// An agent's edit-shaped call, drawn from the diffs of `change`.
function AgentChange({
  verb,
  filePath,
  change,
  mode,
  result,
}: {
  verb: string
  filePath?: string
  change: { diffs: DiffLine[][]; part: string }
  mode: ToolViewProps['mode']
  result: ToolViewProps['result']
}) {
  if (mode === 'approval') {
    return (
      <ApprovalFields>
        {filePath && <FieldRow label='Path' value={filePath} />}
        <ApprovalDiffs path={filePath} diffs={change.diffs} part={change.part} />
      </ApprovalFields>
    )
  }
  return <DiffOpBlock verb={verb} detail={filePath} result={result} diffs={change.diffs} part={change.part} />
}

// A whole-file write, drawn as a diff like an edit: against what the file held
// when the report carries it, otherwise against nothing, as a new file — and
// from the written text in the arguments when nothing was reported.
export function AgentWriteView({ args, diffs: reported, mode, result }: ToolViewProps) {
  const filePath = agentFilePath(args)
  const content = args.content as string | undefined
  const change = useMemo(
    () => agentEditDiffs(reported, () => (content === undefined ? [] : [lineDiff('', content)])),
    [reported, content],
  )
  return <AgentChange verb='Write' filePath={filePath} change={change} mode={mode} result={result} />
}

// A targeted replacement. Its diff is of the replaced text, or of the regions
// around it when the harness reported those — never of the whole file, which
// is not in the call.
export function AgentEditView({ args, diffs: reported, mode, result }: ToolViewProps) {
  const filePath = agentFilePath(args)
  const oldString = args.old_string as string | undefined
  const newString = args.new_string as string | undefined
  const change = useMemo(
    () =>
      agentEditDiffs(reported, () =>
        oldString === undefined && newString === undefined ? [] : [lineDiff(oldString ?? '', newString ?? '')],
      ),
    [reported, oldString, newString],
  )
  return <AgentChange verb='Edit' filePath={filePath} change={change} mode={mode} result={result} />
}

// Several replacements in one file. Each is its own before/after pair, so they
// are drawn as a list of diffs rather than merged — a merged one would have to
// invent a combined "before" that never existed.
export function AgentMultiEditView({ args, diffs: reported, mode, result }: ToolViewProps) {
  const filePath = agentFilePath(args)
  const edits = args.edits
  const change = useMemo(
    () =>
      agentEditDiffs(reported, () =>
        (Array.isArray(edits) ? (edits as Record<string, unknown>[]) : []).map((edit) =>
          lineDiff((edit.old_string as string | undefined) ?? '', (edit.new_string as string | undefined) ?? ''),
        ),
      ),
    [reported, edits],
  )
  return <AgentChange verb='Edit' filePath={filePath} change={change} mode={mode} result={result} />
}

export function RemoteReadView({ args, mode, result }: ToolViewProps) {
  const target = args.target as string | undefined
  const filePath = args.path as string | undefined

  if (mode === 'approval') {
    return (
      <ApprovalFields>
        {target && <TargetRow target={target} />}
        {filePath && <FieldRow label='Path' value={filePath} />}
      </ApprovalFields>
    )
  }

  return (
    <OpBlock
      verb='Read'
      detail={filePath}
      target={target}
      meta={<OpMeta text={linesLabel(result?.text)} />}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(result?.text)}
    >
      <OpRow label='output'>
        <OpOutput result={result} />
      </OpRow>
    </OpBlock>
  )
}

export function RemoteWriteView({ args, requestId, mode, result }: ToolViewProps) {
  const target = args.target as string | undefined
  const filePath = args.path as string | undefined
  const newContent = (args.content as string | undefined) ?? ''
  // Only an approval reads the file: once the write ran, the file holds
  // `newContent` and the state before it is gone.
  const live = useRemoteFile(
    mode === 'approval' ? { target, space: args.space as string | undefined, path: filePath } : undefined,
    requestId,
  )
  // A file that cannot be read is diffed as absent, which is what a write to a
  // new path is — and so is every write once it ran, as there is no before
  // side left to read.
  const current = mode === 'approval' ? (live.text ?? (live.error !== null ? '' : null)) : ''
  const diff = useMemo(() => (current === null ? null : lineDiff(current, newContent)), [current, newContent])

  if (mode === 'approval') {
    return (
      <ApprovalFields>
        {target && <TargetRow target={target} />}
        {filePath && <FieldRow label='Path' value={filePath} />}
        {live.error && <Note>Could not read the existing file ({live.error}); shown as a new one.</Note>}
        {diff ? <ApprovalDiff label={filePath} diff={diff} /> : <Note>Loading current content…</Note>}
      </ApprovalFields>
    )
  }
  return <DiffOpBlock verb='Write' detail={filePath} target={target} result={result} diffs={diff ? [diff] : []} />
}

export function RemoteEditView({ args, requestId, mode, result }: ToolViewProps) {
  const target = args.target as string | undefined
  const filePath = args.path as string | undefined
  const edit = textEdit(args)
  const live = useRemoteFile({ target, space: args.space as string | undefined, path: filePath }, requestId)
  const { original, value } = editSides(mode, live.text, edit)
  const diff = useMemo(() => lineDiff(original, value), [original, value])

  if (mode === 'approval') {
    return (
      <ApprovalFields>
        {target && <TargetRow target={target} />}
        {filePath && <FieldRow label='Path' value={filePath} />}
        {edit.replaceAll && <Note>Replaces every occurrence.</Note>}
        {live.error && <Note>Could not read the existing file ({live.error}); showing the replaced text only.</Note>}
        {live.text === null && !live.error && <Note>Loading current content…</Note>}
        <ApprovalDiff label={filePath} diff={diff} />
      </ApprovalFields>
    )
  }
  return <DiffOpBlock verb='Edit' detail={filePath} target={target} result={result} diffs={[diff]} />
}
