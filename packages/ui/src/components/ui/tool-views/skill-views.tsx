'use client'

import type { ToolViewProps } from 'agent-chat/tool-views'
import { useMemo } from 'react'

import { ApprovalDiff, ApprovalFields, FieldRow, Note } from './approval-fields'
import { lineDiff } from './diff-view'
import { editSides, textEdit, useSkillBody } from './edit-sides'
import { DiffOpBlock, exceedsClamp, linesLabel, OpBlock, OpMeta, OpRow, OpText } from './op-block'

// Views of the skill tools. A skill is a name, a one-line description and a
// markdown body; each view says which skill, whether the call creates it or
// changes it, and what it does to the description and the body.

// Whether a finished skill_write created its skill or replaced one, read from
// the tool's own answer ('Skill "x" created.' / 'Skill "x" updated.'). Unknown
// while the call runs, and for an answer in any other form.
export function skillWriteOutcome(text: string | undefined): 'created' | 'updated' | undefined {
  const match = text?.match(/\b(created|updated)\.\s*$/)
  return match ? (match[1] as 'created' | 'updated') : undefined
}

const WRITE_VERB = { created: 'Create skill', updated: 'Update skill' } as const

function DescriptionRow({ description }: { description: string }) {
  return (
    <OpRow label='about'>
      <OpText text={description} />
    </OpRow>
  )
}

export function SkillWriteView({ args, requestId, mode, result }: ToolViewProps) {
  const name = args.name as string | undefined
  const description = (args.description as string | undefined) ?? ''
  const body = (args.body as string | undefined) ?? ''
  // Only an approval reads the skill: once the write ran, the body before it
  // is gone.
  const live = useSkillBody(mode === 'approval' ? name : undefined, requestId)
  const outcome = skillWriteOutcome(result?.text)
  const current = mode === 'approval' ? live.text : outcome === 'created' ? '' : null
  const diff = useMemo(() => (current === null ? null : lineDiff(current, body)), [current, body])

  if (mode === 'approval') {
    return (
      <ApprovalFields>
        {name && <FieldRow label='Skill' value={name} />}
        {live.text !== null && (
          <Note>{live.text === '' ? 'Creates a new skill.' : 'Replaces the description and body of this skill.'}</Note>
        )}
        <FieldRow label='Description' value={description} />
        {live.error && <Note>Could not read the existing skill ({live.error}).</Note>}
        {diff ? (
          <ApprovalDiff label={name} diff={diff} />
        ) : (
          !live.error && <Note>Loading current skill…</Note>
        )}
      </ApprovalFields>
    )
  }

  const verb = outcome ? WRITE_VERB[outcome] : 'Write skill'
  // A created skill had no body, so its diff is the whole body added. A
  // replaced one had a body that nothing kept — the call does not carry it and
  // the store keeps no earlier version — so the new body is shown as it is,
  // and the row says why there is no diff.
  if (diff) {
    return (
      <DiffOpBlock
        verb={verb}
        detail={name}
        result={result}
        lead={<DescriptionRow description={description} />}
        diffs={[diff]}
      />
    )
  }
  return (
    <OpBlock
      verb={verb}
      detail={name}
      meta={<OpMeta text={linesLabel(body)} />}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(`${description}\n${body}`)}
    >
      {outcome === 'updated' && (
        <div className='px-3 pt-2 text-xs text-muted-foreground'>
          Replaced the description and body. The previous version was not recorded.
        </div>
      )}
      <DescriptionRow description={description} />
      <div className='border-t' />
      <OpRow label='body'>
        <OpText text={body} />
      </OpRow>
    </OpBlock>
  )
}

export function SkillEditView({ args, requestId, mode, result }: ToolViewProps) {
  const name = args.name as string | undefined
  const edit = textEdit(args)
  const live = useSkillBody(name, requestId)
  const { original, value } = editSides(mode, live.text, edit)
  const diff = useMemo(() => lineDiff(original, value), [original, value])

  if (mode === 'approval') {
    return (
      <ApprovalFields>
        {name && <FieldRow label='Skill' value={name} />}
        {edit.replaceAll && <Note>Replaces every occurrence.</Note>}
        {live.error && <Note>Could not read the skill ({live.error}); showing the replaced text only.</Note>}
        {live.text === null && !live.error && <Note>Loading current skill…</Note>}
        <ApprovalDiff label={name} diff={diff} />
      </ApprovalFields>
    )
  }
  return <DiffOpBlock verb='Edit skill' detail={name} result={result} diffs={[diff]} />
}
