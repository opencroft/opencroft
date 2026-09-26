/**
 * A note the engine adds to a steer, for the model's eyes only.
 *
 * WORKAROUND. claude-agent-acp delivers every steer at the
 * Claude SDK's `now` priority, which ABORTS the running cycle. Claude Code then
 * gives each tool call that was issued but had not started its generic
 * user-cancel result, "The user doesn't want to take this action right now.
 * STOP what you are doing and wait for the user to tell you how to proceed."
 * Nobody refused anything, but the model reads it as a stop order and waits
 * for a person who never asked it to. The CLI has an honest wording for this
 * case, but it is behind a server-side flag the host does not control.
 *
 * So when a steer lands while the turn still has tool calls without a result,
 * the adapter's note (HarnessAdapter.steerDeliveryNote) travels with it, and
 * says what such a result means. Remove this once the steer is delivered
 * without aborting issued tool calls, or once the harness's own skip wording
 * is what the model receives.
 *
 * The note is its own content block, never part of the message text. The
 * reader's message is emitted from the delivered text alone, so it renders
 * exactly as typed. A harness replays a user message block by block, and
 * `isDeliveryNote` is how a replayed note is recognised and dropped instead of
 * showing up as something the reader said.
 */

import type { ContentBlock } from '@agentclientprotocol/sdk'

import { isTerminalToolStatus } from './fold'
import type { ChatEvent } from './types'

// Neutral, like the queue tag (see queue-tags.ts): the name is written into
// transcripts and replayed for as long as they exist.
const TAG_NAME = 'delivery-note'
const OPEN = `<${TAG_NAME}>\n`
const CLOSE = `\n</${TAG_NAME}>`

export function deliveryNoteBlock(note: string): ContentBlock {
  return { type: 'text', text: `${OPEN}${note}${CLOSE}` }
}

// The whole block exactly as deliveryNoteBlock writes it, and nothing else: a
// reader's own message that merely starts with the tag is still their message.
export function isDeliveryNote(text: string): boolean {
  return text.length >= OPEN.length + CLOSE.length && text.startsWith(OPEN) && text.endsWith(CLOSE)
}

/**
 * Whether the current turn has a tool call that has not reached a terminal
 * status: one running, or one issued and waiting behind it. "The current turn"
 * is everything after the last `turn_end`. A call's latest reported status
 * decides, and an update carrying none leaves it as it was. A call announced
 * without a status is pending, as ACP defines it.
 */
export function hasUnresolvedToolCalls(events: readonly ChatEvent[]): boolean {
  let start = events.length
  while (start > 0 && events[start - 1].kind !== 'turn_end') {
    start -= 1
  }
  const open = new Set<string>()
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]
    if (event.kind === 'tool_call' && event.status === undefined) {
      open.add(event.toolCallId)
      continue
    }
    if ((event.kind !== 'tool_call' && event.kind !== 'tool_update') || event.status === undefined) {
      continue
    }
    if (isTerminalToolStatus(event.status)) {
      open.delete(event.toolCallId)
    } else {
      open.add(event.toolCallId)
    }
  }
  return open.size > 0
}
