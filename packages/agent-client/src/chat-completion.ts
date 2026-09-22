// Independent chat completions.
//
// The agent loop in native-harness is one way to drive a selection: a prompt
// goes in, tools run, and a stream of ACP events comes out. This is the other
// way — one request, one response, no tools, no session, no events.
//
// It exists so a host can organize a flow the agent loop cannot express: fan
// several completions out across different profiles (a large model for the
// answer, a small local one to classify), combine the results itself, and show
// the reader only what it chooses to show. Each call here is independent — it
// reads no session and writes to none — so the host owns the composition and
// this package never learns what the steps mean.
//
// Native selections only. An ACP agent is a subprocess speaking a protocol, not
// an endpoint that can be posted to, so passing one is refused rather than
// quietly reinterpreted.

import { generateText, type LanguageModelUsage, type ModelMessage, streamText } from 'ai'

import { reasoningProviderOptions, resolveModel } from './endpoint'
import { isNativeSelection } from './resolve'
import type { AgentSelection } from './types'

// One message, in or out.
//
// Deliberately not the AI SDK's ModelMessage: that type is a bundling
// dependency of this package, not part of its contract, and a host composing a
// flow should not have to model tool-call parts to send a sentence.
export interface ChatMessageRecord {
  role: 'system' | 'user' | 'assistant'
  text: string
}

export interface ChatCompletionRequest {
  selection: AgentSelection
  messages: ChatMessageRecord[]
  // Prepended as the system message. The caller composes it — including any
  // skill bodies it wants injected — because what belongs in a system prompt is
  // the host's decision. Falls back to the selection's own prompt.
  system?: string
  // Per-call overrides of what the profile chose. This is how one conversation
  // is run past a cheaper model without editing the profile behind it.
  model?: string
  effort?: string
  temperature?: number
  signal?: AbortSignal
}

export interface ChatCompletionUsage {
  input: number
  output: number
}

export interface ChatCompletionResult {
  text: string
  // The AI SDK's finish reason, not translated into the ACP stop reasons the
  // harness reports. Those describe a turn inside a session; there is no turn
  // and no session here, so mapping would invent a vocabulary for the caller.
  finishReason: string
  // Absent when the endpoint reported nothing — not zero. An endpoint that
  // omits usage is unknown, and a reported zero would read as "cost nothing".
  usage?: ChatCompletionUsage
}

// Text as it arrives, plus the settled result.
//
// Both are offered because a fan-out wants both shapes: the visible answer
// streams so the reader sees it forming, while a classification step is awaited
// as a whole because nobody watches it.
export interface ChatCompletionStream {
  textStream: AsyncIterable<string>
  result: Promise<ChatCompletionResult>
}

function requireNative(selection: AgentSelection): void {
  if (isNativeSelection(selection)) {
    return
  }
  throw new Error(
    `Chat completions need the in-process native harness; "${selection.adapterId}" runs as an ACP subprocess, which speaks a protocol rather than answering an endpoint.`,
  )
}

// The package's records as the SDK's messages. Written as a switch rather than
// a cast so a role the SDK stops accepting fails to compile here instead of at
// the endpoint.
function toModelMessages(messages: ChatMessageRecord[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.text }
      case 'assistant':
        return { role: 'assistant', content: message.text }
      default:
        return { role: 'user', content: message.text }
    }
  })
}

// The SDK's messages as the package's records, for reading a session's history
// back.
//
// Lossy on purpose: tool calls, tool results and every other non-text part are
// dropped, and a message left with no text is omitted entirely. A caller
// reading history to feed another completion wants what was said, and a host
// that wants the tool detail has the event log, which keeps all of it.
export function toChatMessages(messages: ModelMessage[]): ChatMessageRecord[] {
  const records: ChatMessageRecord[] = []
  for (const message of messages) {
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
      continue
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('')
            .trim()
    if (text.length > 0) {
      records.push({ role: message.role, text })
    }
  }
  return records
}

function readUsage(usage: LanguageModelUsage | undefined): ChatCompletionUsage | undefined {
  const input = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  if (input === 0 && output === 0) {
    return undefined
  }
  return { input, output }
}

// The arguments both entry points build the same way, so a difference between
// the streamed and awaited call can only ever be the transport.
function buildRequest(request: ChatCompletionRequest) {
  requireNative(request.selection)
  const { selection } = request
  return {
    model: resolveModel(selection, request.model || selection.model),
    system: (request.system ?? selection.systemPrompt)?.trim() || undefined,
    messages: toModelMessages(request.messages),
    temperature: request.temperature ?? selection.temperature,
    providerOptions: reasoningProviderOptions(
      selection,
      request.effort ?? selection.reasoningEffort,
      request.model || selection.model,
    ),
    abortSignal: request.signal,
  }
}

export async function completeChat(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
  const result = await generateText(buildRequest(request))
  return { text: result.text, finishReason: result.finishReason, usage: readUsage(result.usage) }
}

export function streamChat(request: ChatCompletionRequest): ChatCompletionStream {
  const stream = streamText(buildRequest(request))
  const result = (async (): Promise<ChatCompletionResult> => ({
    text: await stream.text,
    finishReason: await stream.finishReason,
    usage: readUsage(await stream.usage),
  }))()
  // Consuming only textStream is a legitimate use — a caller that renders the
  // text and ignores the totals. Without a handler here, a failure after the
  // stream was abandoned would surface as an unhandled rejection and, under
  // Node's default policy, take the process down. Attaching one marks the
  // promise handled; the caller still sees the rejection if it awaits.
  result.catch(() => {})
  return { textStream: stream.textStream, result }
}
