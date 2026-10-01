import type { ToolViewProps } from 'agent-chat/tool-views'
import { cn } from 'cn'
import { useMemo } from 'react'

import { ApprovalFields, FieldRow, NodeRow, TargetRow } from './approval-fields'
import {
  exceedsClamp,
  linesLabel,
  OpBlock,
  OpFields,
  OpMeta,
  OpOutput,
  OpRow,
  OpText,
  readableJson,
} from './op-block'
import { useToolViewHost } from './tool-view-host'

// Views of calls that run something and answer with text: a command or script
// on a node, a node action, a question put to the user, and any tool without a
// view of its own.

// How much of a run a preview keeps: the first lines of what was run and the
// last lines of what it printed.
const PREVIEW_INPUT_LINES = 2
const PREVIEW_OUTPUT_LINES = 5

type Result = ToolViewProps['result']

// An input row (what ran) over an output row (what it printed). `preview`
// shortens both to what a preview keeps.
function RunBody({ input, result, preview }: { input?: string; result: Result; preview?: boolean }) {
  return (
    <>
      {input && (
        <OpRow label='input'>
          <OpText text={input} head={preview ? PREVIEW_INPUT_LINES : undefined} />
        </OpRow>
      )}
      <div className='border-t' />
      <OpRow label='output'>
        <OpOutput result={result} tail={preview ? PREVIEW_OUTPUT_LINES : undefined} />
      </OpRow>
    </>
  )
}

function RunBlock({
  verb,
  detail,
  target,
  input,
  result,
}: {
  verb: string
  detail?: string
  target?: string
  input?: string
  result: Result
}) {
  return (
    <OpBlock
      verb={verb}
      detail={detail}
      target={target}
      meta={<OpMeta text={linesLabel(result?.text)} />}
      isError={result?.isError}
      pending={!result}
      overflowing={exceedsClamp(input) || exceedsClamp(result?.text)}
      preview={<RunBody input={input} result={result} preview />}
    >
      <RunBody input={input} result={result} />
    </OpBlock>
  )
}

// What a command or script says about itself before it is approved.
function RunFields({ args, input, inputLabel }: { args: Record<string, unknown>; input?: string; inputLabel: string }) {
  const { describeBackgroundRun } = useToolViewHost()
  const target = args.target as string | undefined
  const description = args.description as string | undefined
  const scriptArgs = args.args as string[] | undefined
  const secrets = args.secrets as string[] | undefined
  // Said before approval, not after: a detached command outlives this call.
  const runs = describeBackgroundRun(args)
  return (
    <ApprovalFields>
      {target && <TargetRow target={target} />}
      {description && <FieldRow label='Description' value={description} />}
      {input && <FieldRow label={inputLabel} value={input} />}
      {scriptArgs && scriptArgs.length > 0 && <FieldRow label='Args' value={scriptArgs.join(' ')} />}
      {runs && <FieldRow label='Runs' value={runs} />}
      {secrets && secrets.length > 0 && <FieldRow label='Secrets' value={secrets.join(', ')} />}
    </ApprovalFields>
  )
}

export function RemoteExecView({ args, mode, result }: ToolViewProps) {
  const command = args.command as string | undefined
  if (mode === 'approval') {
    return <RunFields args={args} input={command} inputLabel='Command' />
  }
  return (
    <RunBlock
      verb='Exec'
      detail={args.description as string | undefined}
      target={args.target as string | undefined}
      input={command}
      result={result}
    />
  )
}

export function RemoteScriptView({ args, mode, result }: ToolViewProps) {
  const script = args.script as string | undefined
  if (mode === 'approval') {
    return <RunFields args={args} input={script} inputLabel='Script' />
  }
  return (
    <RunBlock
      verb='Script'
      detail={args.description as string | undefined}
      target={args.target as string | undefined}
      input={script}
      result={result}
    />
  )
}

// A call's arguments or params as named fields, and its answer laid out for
// reading: a JSON object or array indented, other text as it came.
function CallBlock({
  verb,
  detail,
  target,
  values,
  result,
}: {
  verb: string
  detail?: string
  target?: string
  values?: Record<string, unknown>
  result: Result
}) {
  // Laid out for reading here only; the result itself stays as it arrived.
  const shown = useMemo(() => result && { ...result, text: readableJson(result.text) }, [result])
  const hasValues = values !== undefined && Object.keys(values).length > 0
  return (
    <OpBlock
      verb={verb}
      detail={detail}
      target={target}
      isError={result?.isError}
      pending={!result}
      overflowing={Object.keys(values ?? {}).length > 2 || exceedsClamp(shown?.text)}
    >
      {hasValues && <OpFields values={values} />}
      {hasValues && <div className='border-t' />}
      <OpRow label='output'>
        <OpOutput result={shown} />
      </OpRow>
    </OpBlock>
  )
}

// Fallback for a tool call with no registered view (e.g. an external MCP
// server's tool) — the same chrome as every other call, without a target line:
// a generic tool call isn't tied to one of the product's node/handle targets.
export function GenericToolView({ tool, args, result }: { tool: string; args: Record<string, unknown>; result?: Result }) {
  return <CallBlock verb={tool} values={args} result={result} />
}

export function CallView({ args, mode, result }: ToolViewProps) {
  const nodeId = args.nodeId as string | undefined
  const action = args.action as string | undefined
  const params = args.params as Record<string, unknown> | undefined

  if (mode === 'approval') {
    return (
      <ApprovalFields>
        {nodeId && <NodeRow nodeId={nodeId} />}
        {action && <FieldRow label='Action' value={action} />}
        {params && Object.keys(params).length > 0 && (
          <FieldRow label='Params' value={JSON.stringify(params, null, 2)} />
        )}
      </ApprovalFields>
    )
  }
  return <CallBlock verb='Call' detail={action} target={nodeId} values={params} result={result} />
}

interface AskedQuestion {
  question?: string
  header?: string
}

// Where the reply's own words resume after the last answer, in each wording
// the Claude Code CLI has for an answered question.
const ASK_REPLY_CONTINUATIONS = ['. You can now continue', '. Read the answers carefully', '. They also wrote:', '. Call ']

// The answer to each of `questions`, in order, in the harness's reply to an
// AskUserQuestion call — or null unless every one of them can be read out of it.
//
// What the Claude Code CLI sends (read from the code embedded in its binary,
// as installed with claude-agent-acp 0.84.0, 01.10.2026):
// one item per question, `"<question>"="<answer>"` or
// `"<question>"=(no option selected)`, followed by ` selected preview:\n…` and
// ` notes: …` when the user added those, the items joined by `, ` and set
// inside a sentence — `Your questions have been answered: … . You can now
// continue …`, `The user answered: … . Read the answers carefully …`, and
// follow-up variants. Nothing is escaped, so a quote or a `, ` inside an answer
// cannot be told from the format itself. The items are therefore found by the
// questions the view already knows, in order, each running to where the next
// starts; a question the reply leaves out (the CLI drops one with no answer and
// no notes) or a reply worded otherwise yields null, and the view shows the
// reply as it came.
export function askAnswers(text: string | undefined, questions: readonly string[]): string[] | null {
  if (!text || questions.length === 0) {
    return null
  }
  const starts: number[] = []
  for (const question of questions) {
    const start = text.indexOf(`"${question}"=`, (starts.at(-1) ?? -1) + 1)
    if (start < 0) {
      return null
    }
    starts.push(start)
  }
  const tail = starts[starts.length - 1]
  const ends = ASK_REPLY_CONTINUATIONS.map((words) => text.indexOf(words, tail)).filter((index) => index >= 0)
  const end = ends.length > 0 ? Math.min(...ends) : text.length
  const answers: string[] = []
  for (const [index, question] of questions.entries()) {
    const from = starts[index] + question.length + 3
    const to = index + 1 < starts.length ? starts[index + 1] - 2 : end
    const item = text
      .slice(from, to)
      .match(/^(?:"([\s\S]*?)"|(\(no option selected\)))(?: selected preview:\n[\s\S]*?)?(?: notes: ([\s\S]*))?$/)
    if (!item) {
      return null
    }
    const [, answer, unanswered, notes] = item
    answers.push([answer ?? unanswered, notes && `notes: ${notes}`].filter(Boolean).join('\n'))
  }
  return answers
}

// A question the agent put to the user. The question itself is answered on its
// own card, so the transcript row only records it: each question asked, and the
// answer the agent got back for it.
export function AskUserQuestionView({ args, result }: ToolViewProps) {
  const questions = Array.isArray(args.questions) ? (args.questions as AskedQuestion[]) : []
  const asked = questions.map((entry) => entry.question ?? entry.header ?? '').filter(Boolean)
  const detail = questions.length === 1 ? (questions[0].header ?? questions[0].question) : `${questions.length} questions`
  // Only questions that have their own text can be found in the reply; a
  // header alone is not what the reply quotes.
  const answers = questions.every((entry) => entry.question) ? askAnswers(result?.text, asked) : null
  return (
    <OpBlock
      verb='Ask'
      detail={detail}
      isError={result?.isError}
      pending={!result}
      overflowing={asked.length > 2 || (!answers && exceedsClamp(result?.text))}
    >
      {answers ? (
        asked.map((question, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two questions may share their text; position tells them apart
          <div key={index} className={cn(index > 0 && 'border-t')}>
            <OpRow label='asked'>
              <OpText text={question} />
            </OpRow>
            <OpRow label='answer'>
              <OpText text={answers[index]} />
            </OpRow>
          </div>
        ))
      ) : (
        <>
          {asked.length > 0 && (
            <OpRow label='asked'>
              <OpText text={asked.join('\n')} />
            </OpRow>
          )}
          <div className='border-t' />
          <OpRow label='answer'>
            <OpOutput result={result} />
          </OpRow>
        </>
      )}
    </OpBlock>
  )
}
