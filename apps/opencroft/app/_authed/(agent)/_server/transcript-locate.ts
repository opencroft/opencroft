// Where a recorded event sits in the engine's in-memory log.
//
// The recording is written event for event as the engine emits, so it is the
// log's tail and an event's distance from the end is the same on both sides.
// That is the first guess. It is checked rather than trusted, because the two
// can disagree: a batch whose write failed is missing from the recording, and
// a log the harness replayed is not the recording at all. A guess that does not
// hold falls back to the nearest event in the log saying the same thing.

import type { ChatEvent } from 'agent-client/types'

import { questionText } from '@/app/_authed/(agent)/_server/transcript-messages'

/**
 * Where a turn is in the engine's log: at an index; older than anything the log
 * holds (the recording has trimmed it and the log does not reach back that
 * far); or gone, when nothing remembers it.
 */
export type TurnLocation = { kind: 'found'; index: number } | { kind: 'older' } | { kind: 'gone' }

/**
 * Locate the turn starting at a recorded position.
 *
 * `recorded.event` is null once the event cap has trimmed it; the turn is then
 * known only by `indexed`, the search index's message at that position, and is
 * checked against that -- at the guessed index first, then at the nearest
 * index that matches, since a recording written again after an edit can sit a
 * few events off the log.
 */
export function locateTurn(
  log: readonly ChatEvent[],
  recorded: { event: ChatEvent | null; fromEnd: number },
  indexed: { role: 'user' | 'agent'; text: string } | null,
): TurnLocation {
  if (recorded.event) {
    const index = locateRecordedEvent(log, { event: recorded.event, fromEnd: recorded.fromEnd })
    return index === null ? { kind: 'gone' } : { kind: 'found', index }
  }
  if (!indexed) {
    return { kind: 'gone' }
  }
  const index = nearestIndex(log, log.length - recorded.fromEnd, (event) => startsMessage(event, indexed))
  return index === null ? { kind: 'older' } : { kind: 'found', index }
}

// The index nearest `guess` whose event matches, the guess itself first.
function nearestIndex(log: readonly ChatEvent[], guess: number, matches: (event: ChatEvent) => boolean): number | null {
  let nearest: number | null = null
  log.forEach((event, index) => {
    if (matches(event) && (nearest === null || Math.abs(index - guess) < Math.abs(nearest - guess))) {
      nearest = index
    }
  })
  return nearest
}

// Whether `event` is where the indexed message begins: the question itself, or
// the first chunk of a reply that came without one.
function startsMessage(event: ChatEvent, indexed: { role: 'user' | 'agent'; text: string }): boolean {
  if (indexed.role === 'user') {
    return event.kind === 'user' && questionText(event.text) === indexed.text
  }
  return event.kind === 'agent_message' && event.text !== '' && indexed.text.startsWith(event.text)
}

/** The log index of `recorded.event`, or null when the log holds nothing like it. */
export function locateRecordedEvent(
  log: readonly ChatEvent[],
  recorded: { event: ChatEvent; fromEnd: number },
): number | null {
  return nearestIndex(log, log.length - recorded.fromEnd, (event) => sameWords(event, recorded.event))
}

// By kind and words, not by the whole object: the recording is read back from
// JSON storage, which keeps no key order and drops nothing a comparison of the
// words needs.
function sameWords(a: ChatEvent, b: ChatEvent): boolean {
  return a.kind === b.kind && textOf(a) === textOf(b)
}

function textOf(event: ChatEvent): string | null {
  return 'text' in event && typeof event.text === 'string' ? event.text : null
}
