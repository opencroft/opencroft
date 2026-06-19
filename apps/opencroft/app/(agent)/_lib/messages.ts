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
  role: 'user' | 'assistant'
  parts: ChatPart[]
  timestamp: number
  model?: string
}
