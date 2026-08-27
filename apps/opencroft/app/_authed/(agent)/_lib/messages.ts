import type { ResolvedAuthor } from '@/app/_authed/(agent)/_lib/acp-stream'

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool-call'
      id: string
      name: string
      args: unknown
      result?: { text: string; isError?: boolean }
    }

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
