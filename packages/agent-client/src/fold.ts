import type { ChatEvent, CompactionState, ElicitationSchema, PermissionOpt, PlanItem } from './types'

export type ChatMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'thought'; text: string }
  | {
      id: string
      kind: 'tool'
      toolCallId: string
      title: string
      status: string
      input?: unknown
      output?: unknown
    }
  | { id: string; kind: 'plan'; entries: PlanItem[] }
  | {
      id: string
      kind: 'permission'
      requestId: string
      title: string
      options: PermissionOpt[]
      resolved: boolean
      resolvedOptionId?: string
    }
  | {
      id: string
      kind: 'ask'
      requestId: string
      message: string
      // The ask's elicitation shape, carried through from the event: a form
      // schema to render, or a url to visit. Absent = free-text ask.
      form?: ElicitationSchema
      url?: string
      resolved: boolean
    }
  | { id: string; kind: 'error'; text: string }

type ToolMessage = Extract<ChatMessage, { kind: 'tool' }>
type PlanMessage = Extract<ChatMessage, { kind: 'plan' }>

// A tool call is settled once it reaches one of these statuses — every other
// status ('pending', 'in_progress') means more updates are still expected for
// the same toolCallId. Defined here, beside the correlation logic that owns
// the tool-call lifecycle, so renderers and the pagination cut rule share one
// definition instead of each hardcoding the status strings.
//
// 'cancelled' is not an ACP tool-call status — it comes from the compaction
// lifecycle, which folds into a tool-shaped message below and closes with it
// when a compaction is abandoned at a turn boundary. Real tool calls never
// carry it, so listing it here changes nothing for them.
const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export function isTerminalToolStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_TOOL_STATUSES.has(status)
}

// Events carrying "last value wins" session state rather than a step in the
// conversation. They can arrive at any moment — including between two chunks of
// one message — so anything that reads "the previous event" to decide where a
// message begins or ends has to skip them, or an unrelated update splits a
// message in half. Defined here, beside the other shared classification of
// event kinds, so the emit and read sides cannot drift on what is conversation.
//
// The test for a new kind is: **is this a step in the conversation, or state
// that merely happens to arrive during one?** State goes in the set.
//
// It is NOT the same question as withSnapshotPrefix's, and the two lists are
// deliberately different. That one asks which snapshots must be REBUILT for a
// subscriber who joined mid-transcript, so it omits `mode_changed` — `modes`
// already carries `current`, leaving nothing to synthesise. `mode_changed` is
// still session state and still interleaves, so it belongs here. Deriving this
// set from that one is what once left it out.
const SNAPSHOT_KINDS = new Set<ChatEvent['kind']>([
  'modes',
  'mode_changed',
  'config_options',
  'session_info',
  'usage',
  'queue',
  // A background task's live state is "last value wins" and interleaves with
  // conversation exactly like usage does — it must not split a message run,
  // and a windowed subscriber rebuilds the live ones from withSnapshotPrefix.
  'async_task',
  // The agent's plan is the same kind of thing: the agent's present-tense
  // checklist, replaced wholesale by every event and interleaved mid-message
  // (claude-agent-acp fires TodoWrite between text chunks). It must not split
  // a message run, and a windowed subscriber whose cut fell before every plan
  // event is handed the live one by withSnapshotPrefix. Unlike the kinds above
  // it still FOLDS to a message — an upserted checklist row in the transcript,
  // see foldEvents — but its arrival is state, not a step of the conversation.
  'plan',
])

export function isSnapshotEvent(event: ChatEvent): boolean {
  return SNAPSHOT_KINDS.has(event.kind)
}

// The most recent event that is part of the conversation, snapshots ignored.
export function lastConversationEvent(events: ChatEvent[]): ChatEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!isSnapshotEvent(event)) {
      return event
    }
  }
  return undefined
}
type PermissionMessage = Extract<ChatMessage, { kind: 'permission' }>
type AskMessage = Extract<ChatMessage, { kind: 'ask' }>

/**
 * How a compaction presents in a transcript: a tool-shaped row, deliberately.
 *
 * The event vocabulary is honest — 'compaction' is its own ChatEvent kind, so
 * a consumer that wants to render it specially can. But every renderer today
 * draws tool rows, and claude-agent-acp's legacy presentation (before the
 * client advertised the compaction capability) was a synthetic "Compact
 * conversation" tool call — so folding to the same shape keeps the chat
 * looking the way it already did while adding what the honest contract
 * carries: the retained summary as the row's output, the trigger and token
 * counts as its input.
 *
 * The id is namespaced because the legacy presentation used the bare
 * compactionId AS a toolCallId — this one must never collide with a real
 * tool row if both somehow appear in one transcript.
 */
export const COMPACTION_TITLE = 'Compact conversation'

export function compactionView(compaction: CompactionState): {
  id: string
  title: string
  status: string
  input: Record<string, unknown>
  output?: string
  isError: boolean
} {
  const input: Record<string, unknown> = {}
  if (compaction.trigger !== undefined) {
    input.trigger = compaction.trigger
  }
  if (compaction.preTokens !== undefined) {
    input.preTokens = compaction.preTokens
  }
  if (compaction.postTokens !== undefined) {
    input.postTokens = compaction.postTokens
  }
  if (compaction.durationMs !== undefined) {
    input.durationMs = compaction.durationMs
  }
  return {
    id: `compaction:${compaction.compactionId}`,
    title: COMPACTION_TITLE,
    status: compaction.status,
    input,
    output: compaction.summary ?? (compaction.status === 'failed' ? compaction.error : undefined),
    isError: compaction.status === 'failed',
  }
}

export function foldEvents(events: ChatEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  const tools = new Map<string, ToolMessage>()
  const permissions = new Map<string, PermissionMessage>()
  const asks = new Map<string, AskMessage>()
  // The plan is one entity for the whole transcript, not a step: its first
  // event fixes the row's position, later ones patch that row in place, and an
  // empty list retires it (claude-agent-acp publishes one when a conversation
  // reset clears the task store). Held here so the next non-empty plan after a
  // clear anchors a NEW row at its own position.
  let plan: PlanMessage | null = null
  let counter = 0
  const nextId = () => {
    counter += 1
    return String(counter)
  }

  for (const event of events) {
    switch (event.kind) {
      case 'user': {
        messages.push({ id: nextId(), kind: 'user', text: event.text })
        break
      }
      case 'agent_message': {
        const last = messages.at(-1)
        if (last?.kind === 'assistant') {
          last.text += event.text
        } else {
          messages.push({ id: nextId(), kind: 'assistant', text: event.text })
        }
        break
      }
      case 'agent_thought': {
        const last = messages.at(-1)
        if (last?.kind === 'thought') {
          last.text += event.text
        } else {
          messages.push({ id: nextId(), kind: 'thought', text: event.text })
        }
        break
      }
      case 'tool_call': {
        const message: ToolMessage = {
          id: nextId(),
          kind: 'tool',
          toolCallId: event.toolCallId,
          title: event.title,
          status: event.status,
          input: event.input,
        }
        tools.set(event.toolCallId, message)
        messages.push(message)
        break
      }
      case 'tool_update': {
        const message = tools.get(event.toolCallId)
        if (message) {
          message.title = event.title ?? message.title
          message.status = event.status ?? message.status
          message.input = event.input ?? message.input
          message.output = event.output ?? message.output
        }
        break
      }
      case 'plan': {
        if (event.entries.length === 0) {
          if (plan) {
            messages.splice(messages.indexOf(plan), 1)
            plan = null
          }
          break
        }
        if (plan) {
          plan.entries = event.entries
        } else {
          plan = { id: nextId(), kind: 'plan', entries: event.entries }
          messages.push(plan)
        }
        break
      }
      case 'compaction': {
        // Upsert by compactionId, like tool_call/tool_update: every event
        // carries the entity's full merged state, so later ones replace the
        // row's fields in place while the first fixes its timeline position.
        const view = compactionView(event.compaction)
        const existing = tools.get(view.id)
        if (existing) {
          existing.status = view.status
          existing.input = view.input
          if (view.output !== undefined) {
            existing.output = view.output
          }
        } else {
          const message: ToolMessage = {
            id: nextId(),
            kind: 'tool',
            toolCallId: view.id,
            title: view.title,
            status: view.status,
            input: view.input,
            ...(view.output !== undefined ? { output: view.output } : {}),
          }
          tools.set(view.id, message)
          messages.push(message)
        }
        break
      }
      case 'permission_request': {
        const message: PermissionMessage = {
          id: nextId(),
          kind: 'permission',
          requestId: event.requestId,
          title: event.title,
          options: event.options,
          resolved: false,
        }
        permissions.set(event.requestId, message)
        messages.push(message)
        break
      }
      case 'permission_resolved': {
        const message = permissions.get(event.requestId)
        if (message) {
          message.resolved = true
          message.resolvedOptionId = event.optionId
        }
        break
      }
      case 'ask_user': {
        const message: AskMessage = {
          id: nextId(),
          kind: 'ask',
          requestId: event.requestId,
          message: event.message,
          ...(event.form ? { form: event.form } : {}),
          ...(event.url ? { url: event.url } : {}),
          resolved: false,
        }
        asks.set(event.requestId, message)
        messages.push(message)
        break
      }
      case 'ask_user_resolved': {
        const message = asks.get(event.requestId)
        if (message) {
          message.resolved = true
        }
        break
      }
      case 'error': {
        messages.push({ id: nextId(), kind: 'error', text: event.message })
        break
      }
      default:
        break
    }
  }

  return messages
}

export type ChatBlock = { id: string; kind: 'user'; text: string } | { id: string; kind: 'chain'; items: ChatMessage[] }

export function buildBlocks(messages: ChatMessage[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  let chain: ChatMessage[] = []
  const flush = () => {
    const first = chain[0]
    if (first) {
      blocks.push({ id: first.id, kind: 'chain', items: chain })
      chain = []
    }
  }
  for (const message of messages) {
    if (message.kind === 'user') {
      flush()
      blocks.push({ id: message.id, kind: 'user', text: message.text })
    } else {
      chain.push(message)
    }
  }
  flush()
  return blocks
}
