import type { PlanItem } from 'agent-client/types'

import type { ResolvedAuthor } from '@/app/_authed/(agent)/_lib/acp-stream'

export type ChatPart =
  // `messageId` is the harness's own message boundary (see ChatEvent): a text
  // or thinking part carries the id of the message it belongs to, so a fold
  // starts a NEW part when the id changes instead of concatenating two
  // distinct messages into one bubble. That is what keeps a steered turn —
  // where the model's pre- and post-injection replies are different messages
  // — readable rather than a run-on. Absent means the harness said nothing,
  // which merges exactly as before.
  | { type: 'text'; text: string; messageId?: string }
  | { type: 'thinking'; text: string; messageId?: string }
  // `name` is the agent's own phrasing for the call, which is what a reader
  // sees; `toolName` is the programmatic name behind it, which is what decides
  // HOW the call is drawn. See the kit's DetailItem for why they cannot be one
  // field. Absent when the agent named no tool.
  | {
      type: 'tool-call'
      id: string
      name: string
      toolName?: string
      args: unknown
      result?: { text: string; isError?: boolean }
    }
  // A subagent the harness spawned under this turn (see SubagentInfo). Its own
  // transcript is nested verbatim in `parts`, folded from the subagent's
  // session/update stream the same way the parent's is. `state` is absent
  // while it runs; a terminal state closes it.
  | {
      type: 'subagent'
      subagentSessionId: string
      name: string
      task: string
      state?: string
      parts: ChatPart[]
    }
  // A background task the harness reported under this turn (see
  // AsyncTaskInfo). One part per asyncTaskId, placed at the position of its
  // first event and patched in place by later ones — last value wins, the
  // same contract as `subagent`. Unlike a subagent it has no nested
  // transcript: the fields ARE the whole of what a reader can see. Every task
  // becomes a part -- `showInTranscript` is carried as the harness's advice,
  // not applied as a gate; the fold says why.
  | {
      type: 'async-task'
      asyncTaskId: string
      name: string
      taskType: string
      description: string
      state: string
      canStop: boolean
      showInTranscript: boolean
      summary?: string
    }
  // The agent's execution plan (ACP `plan` session update) as ONE part that
  // later plan events patch in place — every event replaces `entries`
  // wholesale, so the part is keyed by the absolute index of the event that
  // anchored it (`id`, same terms as ChatMessage.id) and a clear (empty
  // entries) removes it rather than leaving an empty checklist behind.
  | { type: 'plan'; id: number; entries: PlanItem[] }

export interface ChatMessage {
  // Stable across a "load older" prepend — the absolute index (in the
  // session's full server-side event log) of the raw event that started this
  // message. NOT a position in any locally-held array: that shifts every time
  // older history is prepended, which is what broke React's ability to keep
  // existing DOM nodes in place (and so broke scroll-position restore) when
  // this used to be array-index-derived.
  id: number
  role: 'user' | 'assistant'
  parts: ChatPart[]
  timestamp: number
  model?: string
  // The accounts this turn's messages were stamped by, resolved by the server
  // and carried here rather than looked up.
  //
  // It rides on the MESSAGE, not on a store beside it, so a turn renders the
  // same way regardless of what else is loaded around it. A directory shared
  // across the transcript would make the same message draw a face deep in the
  // scroll and none at the top of it, with bugs that only reproduce at the
  // depth the reporter happened to reach.
  //
  // Absent on an assistant message, and on a user turn whose senders resolve
  // to nothing — which is every turn stamped before accounts had handles.
  authors?: Record<string, ResolvedAuthor>
}
