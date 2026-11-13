import type { AssistantContent, JSONValue, ModelMessage, ToolContent } from 'ai'

import { compactionView, foldEvents } from './fold'
import { compactCommand, summaryMessages } from './native-compaction'
import type { ChatEvent } from './types'

type AssistantPart = Exclude<AssistantContent, string>[number]
type ToolResultPart = Extract<ToolContent[number], { type: 'tool-result' }>

// What the model is told about a call whose result the log never recorded: the
// turn it ran in was stopped, or the process went away, before it settled.
const UNSETTLED_CALL = 'The call was stopped before it finished.'

/**
 * The conversation a native session's model carries, rebuilt from the
 * session's recorded log.
 *
 * The Custom harness keeps a session's messages only in process memory, so a
 * session whose process was stopped (its stop action, an idle unload, a server
 * restart) has nothing of its own to come back from: the host's recording is
 * the one copy left. This reads it back the way the model was given it:
 *
 * - From where the model's context begins: after the newest compaction that
 *   completed, as its summary (see `summaryMessages`), or after the newest
 *   `session_start`, the mark of a session that began with none of the history
 *   above it. A compaction run before a turn's first model call summarised
 *   what came before that turn's prompt, so the prompt stays after the summary;
 *   a `/compact` prompt is the command itself and is not kept.
 * - What was said: the user's messages, the agent's text, and each tool call
 *   with its result, in the AI SDK's shape of a turn: a step's text and calls
 *   as one assistant message, their results as one tool message. The log does
 *   not mark where a step ended, so calls with no text between them read as
 *   one step. A call that never settled is answered as stopped, because a call
 *   without a result is refused by most endpoints.
 * - Left out: reasoning, whose parts an endpoint ties to its own signatures;
 *   pictures, which the log keeps only as references; and everything the reader
 *   saw that the model never did (permission and question cards, notices,
 *   errors).
 *
 * A turn that was stopped is kept as far as it got. The live session drops the
 * unfinished reply and keeps only the prompt, so the rebuilt conversation can
 * hold more of a stopped turn than the session it replaces did, never less.
 */
export function conversationFromLog(events: readonly ChatEvent[]): ModelMessage[] {
  const { from, summary } = contextStart(events)
  // A compaction folds into a tool-shaped row; it is no call of the model's.
  const compactionRows = new Set(
    events.flatMap((event) => (event.kind === 'compaction' ? [compactionView(event.compaction).id] : [])),
  )
  const messages: ModelMessage[] = summary === undefined ? [] : summaryMessages(summary)
  let calls: AssistantPart[] = []
  let results: ToolResultPart[] = []
  const endStep = () => {
    if (calls.length > 0) {
      messages.push({ role: 'assistant', content: calls })
    }
    if (results.length > 0) {
      messages.push({ role: 'tool', content: results })
    }
    calls = []
    results = []
  }
  for (const message of foldEvents(events.slice(from))) {
    switch (message.kind) {
      case 'user':
        endStep()
        messages.push({ role: 'user', content: message.text })
        break
      case 'assistant':
        // Text after a step's calls is the next step's.
        if (results.length > 0) {
          endStep()
        }
        if (message.text) {
          calls.push({ type: 'text', text: message.text })
        }
        break
      case 'tool':
        if (compactionRows.has(message.toolCallId)) {
          break
        }
        calls.push({ type: 'tool-call', toolCallId: message.toolCallId, toolName: message.title, input: message.input ?? {} })
        results.push({
          type: 'tool-result',
          toolCallId: message.toolCallId,
          toolName: message.title,
          output: toolOutput(message.status, message.output),
        })
        break
      default:
        break
    }
  }
  endStep()
  return messages
}

// Where the model's context begins in the log, and the summary it begins with
// when a compaction is what began it.
function contextStart(events: readonly ChatEvent[]): { from: number; summary?: string } {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.kind === 'session_start') {
      return { from: index + 1 }
    }
    if (event.kind === 'compaction' && event.compaction.status === 'completed' && event.compaction.summary) {
      const prompt = promptBeforeFirstCall(events, index)
      return { from: prompt ?? index + 1, summary: event.compaction.summary }
    }
  }
  return { from: 0 }
}

// The prompt of the turn a compaction at `index` ran in, when it ran before the
// turn's first model call (nothing of the agent's lies between them) and the
// prompt was not the `/compact` command itself; otherwise undefined.
function promptBeforeFirstCall(events: readonly ChatEvent[], index: number): number | undefined {
  for (let at = index - 1; at >= 0; at--) {
    const event = events[at]
    if (event.kind === 'user') {
      return compactCommand(event.text) === null ? at : undefined
    }
    if (event.kind === 'agent_message' || event.kind === 'agent_thought' || event.kind === 'tool_call') {
      return undefined
    }
  }
  return undefined
}

// A call's result as the AI SDK gives it to the model: a thrown error as its
// text, a string as text, anything else as the JSON it was recorded as.
function toolOutput(status: string, output: unknown): ToolResultPart['output'] {
  if (status === 'failed') {
    return { type: 'error-text', value: typeof output === 'string' ? output : JSON.stringify(output ?? null) }
  }
  if (status !== 'completed') {
    return { type: 'error-text', value: UNSETTLED_CALL }
  }
  if (typeof output === 'string') {
    return { type: 'text', value: output }
  }
  return { type: 'json', value: (output ?? null) as JSONValue }
}
