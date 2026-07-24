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
}
