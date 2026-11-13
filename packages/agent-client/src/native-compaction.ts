import { randomUUID } from 'node:crypto'

import type { Client, CompactionUpdate } from '@agentclientprotocol/sdk'
import { asSchema, type LanguageModel, type ModelMessage, streamText, type ToolSet } from 'ai'

import { errorMessage } from './errors'
import { toolContentText } from './tool-images'

// Context compaction for the native harness, reported over the same
// `compaction_update` / `compaction_summary_chunk` session updates an ACP
// bridge sends, so the client's compaction handling (the delivery hold, the
// transcript row, the restore hook) cannot tell this harness from a bridged one.

export type CompactionTrigger = 'manual' | 'automatic'

/**
 * A session's context window in tokens (0 when unknown), and whether the
 * person set it on the agent's profile rather than the endpoint reporting it.
 */
export interface ContextWindow {
  size: number
  configured: boolean
}

/**
 * Compact automatically once the context holds this share of a window the
 * endpoint reported.
 *
 * Bound: a reported window is the model's whole window. The summary request
 * carries the whole conversation again, and the summary it writes has to fit
 * beside it in the same window, so the trigger leaves the summary the rest of
 * the window: a fifth of it here. A higher ratio leaves a long summary less
 * room; a lower one only compacts sooner than needed. The value is a judgement
 * inside that bound, not a measurement.
 */
export const REPORTED_WINDOW_COMPACT_RATIO = 0.8

/**
 * The reading at which a session compacts on its own. A configured window is
 * the room the person gives the agent, with whatever the compaction itself
 * needs already left out of it, so the session compacts only once the context
 * has filled all of it. A reported window has no such margin in it, so the
 * harness keeps one (see `REPORTED_WINDOW_COMPACT_RATIO`).
 */
export function autoCompactBar(window: ContextWindow): number {
  return window.configured ? window.size : window.size * REPORTED_WINDOW_COMPACT_RATIO
}

/**
 * Whether a context holding `used` tokens should compact now. A window of size
 * 0 is unknown and never compacts. `after` is the reading the session's latest
 * compaction left, when there was one: measured by the first model call after
 * it, which is sent what the compaction kept and what followed the cut, and
 * the compaction's own estimate (`readingAfter`) until that call has run.
 *
 * A compaction shrinks only the conversation: the system prompt and the tool
 * declarations stay. When they alone fill most of the window, the reading a
 * compaction leaves can still be past the bar, and the next turn (the host's
 * restore note is one) would compact again, without end. So after a
 * compaction the next one also waits until the context has used half the room
 * that compaction left. Any share stops the repeat; a smaller one compacts
 * again sooner on a context a compaction barely shrinks, a larger one lets it
 * fill closer to the window first. Where a compaction leaves plenty of room,
 * the bar is the higher one and decides alone; on a configured window, whose
 * bar is the window itself, it always is. A compaction that left no room
 * at all cannot be helped by another: the session does not compact on its own
 * again until a later compaction (a `/compact`) leaves some. The estimate can
 * count too much, so it holds only until the measured reading replaces it.
 */
export function shouldAutoCompact(used: number | undefined, window: ContextWindow, after?: number): boolean {
  const { size } = window
  if (size <= 0 || used === undefined) {
    return false
  }
  const bar = autoCompactBar(window)
  if (after === undefined) {
    return used >= bar
  }
  return after < size && used >= Math.max(bar, after + (size - after) / 2)
}

/**
 * The context reading a completed compaction leaves: the part of the context
 * it keeps (`fixedTokens`, the system prompt and the tool declarations) plus
 * the summary. It is reported the moment the compaction completes, as the ACP
 * harnesses report theirs, and like theirs it is an estimate that the next
 * model call's measurement replaces. The summary is counted by the summary
 * call's text tokens, as the endpoint measured them; that call's reasoning is
 * not kept. Unknown without the fixed part's estimate or the call's usage.
 */
export function readingAfter(
  fixedTokens: number | undefined,
  usage: { outputTokens?: number; outputTokenDetails?: { textTokens?: number } },
): number | undefined {
  const summaryTokens = usage.outputTokenDetails?.textTokens ?? usage.outputTokens
  if (fixedTokens === undefined || summaryTokens === undefined) {
    return undefined
  }
  return fixedTokens + summaryTokens
}

/**
 * The fixed part's length in characters: the system prompt, and each tool's
 * name, description and input schema as a request declares them.
 */
export async function fixedLength(system: string, tools: ToolSet): Promise<number> {
  let length = system.length
  for (const [name, declared] of Object.entries(tools)) {
    const schema = await asSchema(declared.inputSchema).jsonSchema
    length += name.length + (declared.description?.length ?? 0) + JSON.stringify(schema).length
  }
  return length
}

/**
 * Tokens per character of a model call sent the fixed part and `messages`,
 * from the input tokens the endpoint measured for it. Taken from a session's
 * first call, which is mostly the fixed part, it counts the fixed part at the
 * endpoint's own tokenizer rather than at a guessed characters-per-token.
 */
export function tokensPerCharacter(inputTokens: number, fixed: number, messages: readonly ModelMessage[]): number {
  const length = messages.reduce((sum, message) => sum + partsText(message.content).length, fixed)
  return length > 0 ? inputTokens / length : 0
}

/**
 * `/compact`, optionally followed by what the summary should focus on, as the
 * prompt's text: the instructions (possibly empty), or null for any other
 * prompt. The client sends a command as typed, slash first, so nothing is
 * trimmed off the front.
 */
export function compactCommand(text: string): string | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trimEnd())
  return match ? (match[1] ?? '').trim() : null
}

const SUMMARY_SYSTEM = [
  'You summarise a conversation between a user and an AI agent so that the agent can carry on from the summary alone: the conversation itself is about to be dropped.',
  'Write the summary in plain text with these sections:',
  "1. The user's requests and intent, in full, including any instruction that still applies.",
  '2. Key facts, decisions and technical details established so far.',
  '3. Files, resources and identifiers worked with, and what was done to each.',
  '4. Errors met and how they were resolved.',
  '5. What is pending.',
  '6. The work in progress at the end of the conversation, and the exact next step.',
  'Keep every detail the agent needs to continue; leave out pleasantries and anything already superseded.',
].join('\n')

const RESUME_PREAMBLE =
  'This session continues an earlier conversation that was compacted to free context. The summary below replaces it.'

// Said only to the model calls that follow a compaction in the middle of a
// turn, which continue that turn with the summary as all they have. Never
// stored: the next turn starts from the user's own message, not from an order
// to resume work that may have been stopped.
const CONTINUE_INSTRUCTION =
  'Continue the work in progress from where it stopped, without asking the user to repeat anything.'

function partsText(content: ModelMessage['content']): string {
  if (typeof content === 'string') {
    return content
  }
  const lines: string[] = []
  for (const part of content) {
    switch (part.type) {
      case 'text':
        lines.push(part.text)
        break
      case 'image':
      case 'file':
        lines.push('[attachment]')
        break
      case 'tool-call':
        lines.push(`[called tool ${part.toolName} with ${JSON.stringify(part.input)}]`)
        break
      case 'tool-result': {
        // A picture a tool returned is written as a line saying what it was:
        // the summary keeps that it was seen, never its bytes.
        if (part.output.type === 'content') {
          lines.push(`[tool ${part.toolName} returned: ${toolContentText(part.output.value)}]`)
          break
        }
        const output = part.output as { type: string; value?: unknown; reason?: string }
        const value =
          output.value === undefined
            ? (output.reason ?? output.type)
            : typeof output.value === 'string'
              ? output.value
              : JSON.stringify(output.value)
        lines.push(`[tool ${part.toolName} returned${output.type.startsWith('error') ? ' an error' : ''}: ${value}]`)
        break
      }
      default:
        // Reasoning and provider-specific parts are the model's own working,
        // not part of what was said.
        break
    }
  }
  return lines.join('\n')
}

const ROLE_LABEL: Record<ModelMessage['role'], string> = {
  system: 'System',
  user: 'User',
  assistant: 'Agent',
  tool: 'Tool',
}

/**
 * The conversation as one plain-text transcript. Sent as text rather than as
 * the messages themselves so the summary request carries no tool calls: an
 * OpenAI-compatible endpoint may refuse tool messages in a request that
 * declares no tools, and declaring them would invite the model to call one.
 */
export function transcriptText(messages: readonly ModelMessage[]): string {
  return messages
    .map((message) => `${ROLE_LABEL[message.role]}: ${partsText(message.content)}`)
    .filter((line) => !/^\w+: $/.test(line))
    .join('\n\n')
}

/**
 * The message a compacted conversation is replaced with. `continueTurn` adds
 * the instruction to carry on, for the rest of a turn compacted mid-way.
 */
export function summaryMessages(summary: string, continueTurn = false): ModelMessage[] {
  const text = [RESUME_PREAMBLE, `<summary>\n${summary}\n</summary>`, ...(continueTurn ? [CONTINUE_INSTRUCTION] : [])]
  return [{ role: 'user', content: text.join('\n\n') }]
}

export interface CompactionRun {
  client: Client
  sessionId: string
  messages: readonly ModelMessage[]
  trigger: CompactionTrigger
  /** What a `/compact` asked the summary to focus on; empty for none. */
  instructions?: string
  model: LanguageModel
  providerOptions?: Parameters<typeof streamText>[0]['providerOptions']
  temperature?: number
  abortSignal: AbortSignal
  /** The context reading before the compaction, when one is known. */
  preTokens?: number
  /** The estimate of the part of the context a compaction keeps, when one is known. */
  fixedTokens?: number
}

export type CompactionOutcome =
  | { status: 'completed'; summary: string; postTokens?: number }
  | { status: 'failed' | 'cancelled' }

/**
 * Summarise `messages` with the session's own model and report it: one
 * `in_progress`, the summary streamed as chunks, then exactly one of
 * `completed`, `failed` or `cancelled`. The model call's failure is reported,
 * not thrown; a compaction that does not complete leaves the caller's messages
 * as they were.
 */
export async function runCompaction(run: CompactionRun): Promise<CompactionOutcome> {
  const { client, sessionId, trigger } = run
  const compactionId = randomUUID()
  const startedAt = Date.now()
  const report = (update: Omit<CompactionUpdate, 'compactionId'>) =>
    client.sessionUpdate({ sessionId, update: { sessionUpdate: 'compaction_update', compactionId, ...update } })
  await report({ status: 'in_progress', _meta: { contextCompaction: { version: 1, trigger } } })

  const fail = async (status: 'failed' | 'cancelled', error?: string): Promise<CompactionOutcome> => {
    await report({ status, ...(error ? { error } : {}) })
    return { status }
  }
  if (run.messages.length === 0) {
    return fail('failed', 'There is nothing to compact yet: the conversation is empty.')
  }

  const focus = run.instructions ? `\n\nFocus the summary on: ${run.instructions}` : ''
  const request = `<conversation>\n${transcriptText(run.messages)}\n</conversation>\n\nSummarise the conversation above.${focus}`
  let summary = ''
  try {
    const result = streamText({
      model: run.model,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: request }],
      abortSignal: run.abortSignal,
      temperature: run.temperature,
      providerOptions: run.providerOptions,
    })
    for await (const part of result.fullStream) {
      if (part.type === 'error') {
        throw part.error
      }
      if (part.type === 'text-delta' && part.text) {
        summary += part.text
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'compaction_summary_chunk',
            compactionId,
            content: { type: 'text', text: part.text },
          },
        })
      }
    }
    // An abort can end the stream without throwing (see the harness's turn).
    if (run.abortSignal.aborted) {
      return fail('cancelled')
    }
    summary = summary.trim()
    if (!summary) {
      return fail('failed', 'The model returned an empty summary.')
    }
    const postTokens = readingAfter(run.fixedTokens, await result.usage)
    await report({
      status: 'completed',
      summary: [{ type: 'text', text: summary }],
      _meta: {
        contextCompaction: {
          version: 1,
          trigger,
          ...(run.preTokens !== undefined ? { preTokens: run.preTokens } : {}),
          ...(postTokens !== undefined ? { postTokens } : {}),
          durationMs: Date.now() - startedAt,
        },
      },
    })
    return { status: 'completed', summary, postTokens }
  } catch (error) {
    if (run.abortSignal.aborted) {
      return fail('cancelled')
    }
    return fail('failed', errorMessage(error))
  }
}
