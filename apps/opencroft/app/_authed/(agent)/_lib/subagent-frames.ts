// A subagent's step as the session's stream carries it: wrapped once per
// subagent above it, outermost first, with the step's position in the
// innermost subagent's own log on the innermost wrapper (agent-client's
// `compactLog`). The step belongs to that log, not to the session's: the chat
// draws it in the subagent's section, never in the session's history.

import type { ChatEvent } from 'agent-client/types'

/** A positioned step: the log it is an entry of, where, and the entry. */
export interface SubagentStep {
  subagentSessionId: string
  position: number
  event: ChatEvent
}

/**
 * The step a frame carries, or null for a frame that is not one with a
 * position: any other event, or a step stored inline in the session's own log
 * with no position (which the session's fold draws).
 */
export function subagentStepOf(frame: ChatEvent): SubagentStep | null {
  let wrapper = frame
  while (wrapper.kind === 'subagent_event' && wrapper.event.kind === 'subagent_event') {
    wrapper = wrapper.event
  }
  if (wrapper.kind !== 'subagent_event' || wrapper.position === undefined) {
    return null
  }
  return { subagentSessionId: wrapper.subagentSessionId, position: wrapper.position, event: wrapper.event }
}

/**
 * The frame with its step replaced by `entry`: the entry as its log holds it
 * now. A step that merged into an entry (a chunk of a run, an update of a call)
 * carries only what it added, and a section loaded after part of it was
 * written would add that part twice; the entry is the whole of it, so applying
 * one frame or another for the same position, in any order, ends the same.
 */
export function withEntry(frame: ChatEvent, entry: ChatEvent): ChatEvent {
  if (frame.kind !== 'subagent_event') {
    return frame
  }
  if (frame.event.kind === 'subagent_event') {
    return { ...frame, event: withEntry(frame.event, entry) }
  }
  return { ...frame, event: entry }
}
