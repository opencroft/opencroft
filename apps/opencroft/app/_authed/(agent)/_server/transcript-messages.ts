// How a recorded transcript becomes searchable messages (TranscriptMessage).
//
// Pure: events in, rows out, plus the state the next stretch of events
// continues from. The event store runs each batch through it as the batch is
// written, and a process that did not see the events -- after a restart, or
// for history recorded before the index existed -- runs them through the same
// function read back from the store, so every message is cut by one rule.
//
// THE RULE: a message is either a question -- one `user` event, as the words
// the chat shows for it -- or an agent's reply: every `agent_message` chunk
// from the first until the reply ENDS, which is at the turn's `turn_end`, at
// an `error`, at the next question, or with the process that was writing it
// (see `endOpenReply`). Tool calls in between do not split a reply; text after
// a reply has ended starts a new one in the same turn. Thoughts, tool calls
// and everything else the chat folds away are not searched.
//
// A reply is written when it ends, so a batch that only carries chunks of it
// writes nothing. Its text is held until then, but never more than about
// twice SEGMENT_CHARS of it: past SEGMENT_CHARS the held text is written out
// as a segment at the next word break, and past twice that regardless. That
// bounds the memory a reply holds and the row a tsvector is built from
// (Postgres refuses one of a megabyte or more), and makes a long reply
// searchable before it ends. Every write falls between two events, so the
// first event not yet written is always a whole position (`resumeFrom`).

import { decodeBatch } from 'agent-client/queue-tags'
import type { ChatEvent } from 'agent-client/types'

/**
 * The size, in characters, after which held text is written out at the next
 * word break. The worst case for the parsed size is a text of distinct words
 * of a few characters each, which parses to about three bytes per character
 * -- so a segment stays well under a tenth of the limit even at twice this.
 */
export const SEGMENT_CHARS = 16_000
const MAX_SEGMENT_CHARS = 2 * SEGMENT_CHARS

export interface RecordedEvent {
  position: number
  event: ChatEvent
  createdAt: Date
}

/** One row of TranscriptMessage. */
export interface MessageRow {
  /** The message's first event. */
  position: number
  segment: number
  role: 'user' | 'agent'
  /** The question the message belongs to: where a search hit opens. */
  turn: number
  text: string
  createdAt: Date
}

/** A reply that has not ended: where it started, the segment it writes next, and its text not yet written. */
export interface OpenReply {
  position: number
  segment: number
  text: string
  createdAt: Date
}

export interface IndexState {
  /** The first event the written rows do not account for. */
  resumeFrom: number
  /** The open turn: its question's position, or a reply's that came without one. */
  turn: number | null
  open: OpenReply | null
}

export interface IndexStep {
  rows: MessageRow[]
  state: IndexState
  /** Whether the state moved in a way that must be recorded: rows were cut, or a turn or reply ended. */
  persist: boolean
}

export const INITIAL_STATE: IndexState = { resumeFrom: 0, turn: null, open: null }

/**
 * The rows `events` complete, given the state the transcript was in before
 * them.
 *
 * Reply text before any question -- a transcript whose opening turn was cut by
 * the event cap, or an agent speaking first -- opens a turn at its own first
 * chunk, so it is still searchable and still has somewhere to open at.
 */
export function indexEvents(state: IndexState, events: readonly RecordedEvent[]): IndexStep {
  const step: IndexStep = {
    rows: [],
    state: { ...state, open: state.open && { ...state.open } },
    persist: false,
  }
  for (const { position, event, createdAt } of events) {
    // Already accounted for: a stretch of history recorded again (an edit's
    // fork, a harness replay) that the rows already hold.
    if (position < step.state.resumeFrom) {
      continue
    }
    switch (event.kind) {
      case 'user': {
        closeReply(step, position)
        step.state.turn = position
        for (const [segment, text] of splitText(questionText(event.text)).entries()) {
          step.rows.push({ position, segment, role: 'user', turn: position, text, createdAt })
        }
        step.state.resumeFrom = position + 1
        break
      }
      case 'agent_message': {
        if (event.text === '') {
          break
        }
        const held = step.state.open
        if (held && held.text.length >= SEGMENT_CHARS && /^\s/.test(event.text)) {
          writeHeld(step, position)
        }
        step.state.turn ??= position
        step.state.open ??= { position, segment: 0, text: '', createdAt }
        step.state.open.text += event.text
        const length = step.state.open.text.length
        if (length >= MAX_SEGMENT_CHARS || (length >= SEGMENT_CHARS && /\s$/.test(event.text))) {
          writeHeld(step, position + 1)
        }
        break
      }
      case 'turn_end':
      case 'error':
        closeReply(step, position + 1)
        break
      default:
        break
    }
  }
  return step
}

/**
 * End the reply `state` holds open, as of `through` (the first event after the
 * ones already applied). For a reply whose writer is gone: a process that
 * reads a transcript back from the store ends the reply it finds open, because
 * the process that was streaming it no longer is and nothing will end it.
 */
export function endOpenReply(state: IndexState, through: number): IndexStep {
  const step: IndexStep = { rows: [], state: { ...state, open: state.open && { ...state.open } }, persist: false }
  if (step.state.open) {
    closeReply(step, through)
  }
  return step
}

// Also recorded when nothing was open: the events up to here are then
// accounted for, and a process reading the transcript back starts after them.
function closeReply(step: IndexStep, through: number): void {
  writeHeld(step, through)
  step.state.open = null
  step.state.resumeFrom = through
  step.persist = true
}

// Write the open reply's held text out as segments, as of `through`.
function writeHeld(step: IndexStep, through: number): void {
  const open = step.state.open
  if (!open) {
    return
  }
  for (const text of splitText(open.text)) {
    step.rows.push({
      position: open.position,
      segment: open.segment,
      role: 'agent',
      turn: step.state.turn ?? open.position,
      text,
      createdAt: open.createdAt,
    })
    open.segment += 1
  }
  open.text = ''
  step.state.resumeFrom = through
  step.persist = true
}

/**
 * `text` cut into segments. A text that fits in one is left whole -- held
 * reply text is written out at a word break already, and cutting it again
 * would leave a sliver. A longer one is cut at the first word break past
 * SEGMENT_CHARS, and at twice that regardless (only a text without spaces gets
 * there), never between the halves of a surrogate pair. Joined, the pieces are
 * the text.
 */
export function splitText(text: string): string[] {
  const pieces: string[] = []
  let rest = text
  while (rest !== '') {
    const take = segmentLength(rest)
    pieces.push(rest.slice(0, take))
    rest = rest.slice(take)
  }
  return pieces
}

function segmentLength(text: string): number {
  if (text.length <= MAX_SEGMENT_CHARS) {
    return text.length
  }
  const breakAt = text.slice(SEGMENT_CHARS, MAX_SEGMENT_CHARS).search(/\s/)
  if (breakAt !== -1) {
    return SEGMENT_CHARS + breakAt
  }
  const take = Math.min(text.length, MAX_SEGMENT_CHARS)
  return take < text.length && isHighSurrogate(text.charCodeAt(take - 1)) ? take - 1 : take
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * The words the reader sees for a delivered question: each message's body,
 * without the tag lines that frame it or the note addressed to the agent ahead
 * of them -- the same parts the chat renders.
 */
export function questionText(delivered: string): string {
  return decodeBatch(delivered)
    .map((message) => message.text)
    .join('\n\n')
}
