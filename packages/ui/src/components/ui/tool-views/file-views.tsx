'use client'

import type { ToolViewProps } from 'agent-chat/tool-views'
import { useMemo } from 'react'

import { ApprovalDiff, ApprovalFields, FieldRow, Note, TargetRow } from './approval-fields'
import { type DiffLine, lineDiff } from './diff-view'
import { editSides, textEdit, useRemoteFile } from './edit-sides'
import { DiffOpBlock, exceedsClamp, linesLabel, OpBlock, OpMeta, OpOutput, OpRow, OpText } from './op-block'

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
// diff per region it named (a whole file, or one hunk of it) — or, when no
// region came with its before side, the text written.
//
// A region without a before side (`oldText` null) is not read as a created
// file. claude-agent-acp 0.84.0 reports every Write that way, overwrites
// included, because the call's input does not say whether the file existed;
// the real diff follows only from its post-write hook, which a replayed
// session does not run. A diff against nothing would claim every line new, so
// that text is shown as written instead. Where some regions do have a before
// side, those are the change.
function reportedChange(diffs: ToolViewProps['diffs']): { diffs: DiffLine[][]; written: string | null } | null {
  if (!diffs?.length) {
    return null
  }
  const known = diffs.flatMap((diff) => (diff.oldText === null ? [] : [lineDiff(diff.oldText, diff.newText)]))
  return known.length > 0 ? { diffs: known, written: null } : { diffs: [], written: diffs.map((diff) => diff.newText).join('\n') }
}

// An agent edit's diffs: the reported ones, or the ones its arguments spell
// out. `part` is what each one is, for the heading over several; `written` is
// set instead when the report carried only written text.
function agentEditDiffs(
  reported: ToolViewProps['diffs'],
  fromArgs: () => DiffLine[][],
): { diffs: DiffLine[][]; part: string; written: string | null } {
  const change = reportedChange(reported)
  return change ? { ...change, part: 'Change' } : { diffs: fromArgs(), part: 'Edit', written: null }
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

// Text a call wrote where the prior contents are not known here, so there is
// nothing to diff against: the resulting text is shown on its own.
function WrittenFile({
  verb = 'Write',
  path,
  content,
  target,
  result,
}: {
  verb?: string
  path?: string
  content: string
  target?: string
  result: ToolViewProps['result']
}) {
  return (
    <OpBlock
      verb={verb}
      detail={path}
      target={target}
      meta={<OpMeta text={linesLabel(content)} />}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(content)}
    >
      <OpRow label='content'>
        <OpText text={content} />
      </OpRow>
    </OpBlock>
  )
}

// An agent's edit-shaped call, drawn from `change`: the diffs, or the written
// text when that is all that was reported.
function AgentChange({
  verb,
  filePath,
  change,
  mode,
  result,
}: {
  verb: string
  filePath?: string
  change: { diffs: DiffLine[][]; part: string; written: string | null }
  mode: ToolViewProps['mode']
  result: ToolViewProps['result']
}) {
  if (mode === 'approval') {
    return (
      <ApprovalFields>
        {filePath && <FieldRow label='Path' value={filePath} />}
        {change.written !== null ? (
          <FieldRow label='Content' value={change.written} />
        ) : (
          <ApprovalDiffs path={filePath} diffs={change.diffs} part={change.part} />
        )}
      </ApprovalFields>
    )
  }
  if (change.written !== null) {
    return <WrittenFile verb={verb} path={filePath} content={change.written} result={result} />
  }
  return <DiffOpBlock verb={verb} detail={filePath} result={result} diffs={change.diffs} part={change.part} />
}

// A whole-file write. A reported diff with a before side shows what the file
// held; otherwise the written file is shown on its own — from the report, or
// from the arguments when nothing was reported.
export function AgentWriteView({ args, diffs: reported, mode, result }: ToolViewProps) {
  const filePath = agentFilePath(args)
  const content = args.content as string | undefined
  const reportedWrite = useMemo(() => reportedChange(reported), [reported])
  const change = reportedWrite ?? { diffs: [], written: content ?? null }
  return <AgentChange verb='Write' filePath={filePath} change={{ ...change, part: 'Change' }} mode={mode} result={result} />
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
  // new path is.
  const current = live.text ?? (live.error !== null ? '' : null)
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
  return <WrittenFile path={filePath} content={newContent} target={target} result={result} />
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
