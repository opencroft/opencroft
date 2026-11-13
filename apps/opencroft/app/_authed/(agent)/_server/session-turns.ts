// A session's history read as turns: a page of short summaries to see what an
// agent is doing, and one turn whole to read what it answered. Callers own
// their authorization (the thread membership of whoever asks); these functions
// only answer for a session key the caller is already allowed to see.
//
// A loaded session is read through the engine (what it holds, and below that
// its stored transcript), an offline one from its stored transcript, without
// starting it. Either way the log is read a page at a time, never whole. An
// `index` is a log position, the stored one less the transcript's first:
// what a reopen numbers the engine's log by, so a loaded and an offline read
// agree while the history settings leave the transcript's front alone. One
// that trims it renumbers the next reopen, so a caller whose `sessionStatus`
// changed between offline and not lists the turns again.

import { foldEvents, isSnapshotEvent } from 'agent-client/fold'
import { type LogReader, turnAtFromReader, turnsWindowFromReader } from 'agent-client/pagination'
import type { ChatEvent } from 'agent-client/types'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { sessionActivitySets } from '@/app/_authed/(agent)/_server/session-activity'
import { storedLogReader } from '@/app/_authed/(agent)/_server/session-event-store'
import { deriveSessionStatus, type SessionStatus } from '@/app/_authed/(agent)/_shared/session-status'

export interface TurnSummary {
  index: number
  prompt: string
  promptLength: number
  // 'unknown' is a replayed turn: it ended — a later prompt proves it — but a
  // session/load replay does not say how, so neither does this.
  status: 'finished' | 'in-progress' | 'interrupted' | 'unknown'
  finalMessage?: string
  finalMessageLength?: number
}

export interface TurnsPage {
  turns: TurnSummary[]
  hasMore: boolean
  nextBeforeIndex: number | null
  // The session's own status (see deriveSessionStatus). 'offline' means the
  // turns were read from the stored transcript: none of them is in progress,
  // because no process is running one.
  sessionStatus: SessionStatus
}

export interface TurnDetail {
  // Null when no turn of the session's history holds `index`.
  turn: TurnSummary | null
  // The cap applied to `prompt` and to `finalMessage`, each on its own.
  maxChars: number
  // Whether either text was cut at `maxChars`. Its `…Length` is the full length.
  truncated: boolean
  sessionStatus: SessionStatus
}

// ~400 chars is enough to identify a turn at a glance without pulling its
// full text into an agent's context — these actions must stay cheap to call
// regardless of how long a session's transcript is.
const TURN_TEXT_MAX_CHARS = 400
// One turn read whole: large enough for any answer an agent writes to another,
// bounded so a pasted log cannot fill the reader's context.
const FULL_TURN_MAX_CHARS = 50_000
const DEFAULT_TURNS = 10
// `turns` is caller-controlled — an unbounded value would walk the whole
// transcript and scale the response with it, defeating the point of keeping
// each turn's text truncated.
const MAX_TURNS = 50

// The session's event log, as a reader, and whether its last turn is still
// running: the loaded session's own log, or else the stored transcript, which
// no process is adding to.
async function sessionLog(sessionKey: string): Promise<{ reader: LogReader; turnActive: boolean }> {
  const meta = agentClient.listSessions().find((m) => m.sessionKey === sessionKey)
  const reader = meta ? agentClient.logReader(meta.id) : null
  if (meta && reader) {
    return { reader, turnActive: agentClient.hasActiveTurn(meta.id) }
  }
  return { reader: await storedLogReader(sessionKey), turnActive: false }
}

// The turn-paging core shared by every surface that lists a session's turns
// — same window, same summaries, same paging, so a turn reads identically
// wherever it is inspected from.
export async function turnsPageForSessionKey(
  sessionKey: string,
  params: { turns?: number; beforeIndex?: number },
): Promise<TurnsPage> {
  const turns = params.turns && params.turns > 0 ? Math.min(Math.floor(params.turns), MAX_TURNS) : DEFAULT_TURNS
  const sessionStatus = deriveSessionStatus(sessionKey, sessionActivitySets())
  const log = await sessionLog(sessionKey)
  const window = await turnsWindowFromReader(log.reader, { beforeIndex: params.beforeIndex, turns })
  // Only the tail window (no beforeIndex) can end on the session's current,
  // still-running turn — any older page is by definition already over.
  const tailInProgress = params.beforeIndex === undefined && log.turnActive
  const groups = splitIntoTurns(window.events, window.startIndex)
  return {
    turns: groups.map((group, i) =>
      buildTurnSummary(group.index, group.events, tailInProgress && i === groups.length - 1),
    ),
    hasMore: window.hasMore,
    nextBeforeIndex: window.hasMore ? window.startIndex : null,
    sessionStatus,
  }
}

// One turn of a session in full: the summary a page lists, with its texts
// capped at FULL_TURN_MAX_CHARS instead of the page's preview length. `index`
// is a turn's `index` from a page; any event index inside a turn names that
// turn too, so an index taken from a page whose window began inside a prompt
// still resolves.
export async function turnForSessionKey(sessionKey: string, index: number): Promise<TurnDetail> {
  const sessionStatus = deriveSessionStatus(sessionKey, sessionActivitySets())
  const missing: TurnDetail = { turn: null, maxChars: FULL_TURN_MAX_CHARS, truncated: false, sessionStatus }
  if (!Number.isInteger(index) || index < 0) {
    return missing
  }
  const { reader, turnActive } = await sessionLog(sessionKey)
  const found = await turnAtFromReader(reader, index)
  const group = found ? splitIntoTurns(found.events, found.startIndex)[0] : undefined
  if (!found || !group) {
    return missing
  }
  const inProgress = found.last && turnActive
  const turn = buildTurnSummary(group.index, group.events, inProgress, FULL_TURN_MAX_CHARS)
  const truncated = turn.promptLength > FULL_TURN_MAX_CHARS || (turn.finalMessageLength ?? 0) > FULL_TURN_MAX_CHARS
  return { turn, maxChars: FULL_TURN_MAX_CHARS, truncated, sessionStatus }
}

export function truncateText(text: string, max = TURN_TEXT_MAX_CHARS): { text: string; length: number } {
  const length = text.length
  return length <= max ? { text, length } : { text: `${text.slice(0, max)}… [truncated]`, length }
}

export function turnStatus(events: ChatEvent[], inProgress: boolean): TurnSummary['status'] {
  if (inProgress) {
    return 'in-progress'
  }
  const end = events.find((e) => e.kind === 'turn_end')
  if (end?.kind !== 'turn_end') {
    // No terminal event at all: the turn errored (settleTurn's failure path
    // never emits turn_end) or the process died mid-turn — either way, cut
    // off rather than completed.
    return 'interrupted'
  }
  // 'replayed' = a synthetic boundary loadSession reconstructs between two
  // replayed turns. It says the turn ended — the prompt that follows proves
  // that — and nothing about how, because the replay carries no stopReason.
  // Reporting these as finished would claim an outcome never observed; as
  // interrupted, it would claim a failure that never happened.
  if (end.stopReason === 'replayed') {
    return 'unknown'
  }
  // 'cancelled' = force-interrupted (stopProcessLocal/force-send); 'resumed'
  // = a synthetic marker loadSession emits for the LAST replayed turn, the one
  // a restart could have cut off mid-flight (see agent-client.ts) — both are
  // incomplete, not finished.
  return end.stopReason === 'cancelled' || end.stopReason === 'resumed' ? 'interrupted' : 'finished'
}

// The prompt that opened a turn, joined back together. A message is a run of
// 'user' events (one per content delta), and splitIntoTurns puts that whole run
// at the head of the group — so the prompt is the leading run, not its first
// event. Reading one event would report a fragment as the whole question.
function openingPrompt(events: ChatEvent[]): string {
  let text = ''
  for (const event of events) {
    // Snapshots are not part of the message and can interleave with its chunks,
    // so they neither contribute text nor end the run.
    if (isSnapshotEvent(event)) {
      continue
    }
    if (event.kind !== 'user') {
      break
    }
    text += event.text
  }
  return text
}

export function buildTurnSummary(
  index: number,
  events: ChatEvent[],
  inProgress: boolean,
  maxChars = TURN_TEXT_MAX_CHARS,
): TurnSummary {
  const prompt = truncateText(openingPrompt(events), maxChars)
  const status = turnStatus(events, inProgress)
  const summary: TurnSummary = { index, prompt: prompt.text, promptLength: prompt.length, status }
  // 'unknown' carries its final message too: a replayed turn's reply was
  // recorded in full and only its ENDING went unobserved. Withholding text that
  // is right there would make a turn listing least useful on exactly the
  // sessions this status exists for. 'in-progress' and 'interrupted' still
  // omit it — there the text really is partial.
  if (status === 'finished' || status === 'unknown') {
    // `agent_message` is a streaming chunk, not a whole message: one is emitted
    // per content delta, so a reply arrives as a run of them. Fold the events
    // back into messages — the same concatenation the chat view renders from —
    // and take the last assistant message. Reading the last event on its own
    // would report only that message's trailing fragment.
    const assistantMessages = foldEvents(events).filter((message) => message.kind === 'assistant')
    const final = truncateText(assistantMessages.at(-1)?.text ?? '', maxChars)
    summary.finalMessage = final.text
    summary.finalMessageLength = final.length
  }
  return summary
}

// Split a window's flat event array back into per-turn groups, tagging each
// with its absolute index (window.startIndex + offset) so it can double as
// the next page's `beforeIndex` cursor. tailByTurns/pageBeforeByTurns cut at
// 'user' boundaries when any exist, but a session with zero turns (created,
// never prompted — only 'modes'/'config_options'/etc. snapshot events) has
// none: tailByTurns then returns that whole snapshot-only log as-is, not
// starting with 'user'. Those leading events aren't part of any turn — skip
// them (nothing to attach them to) rather than assume the invariant holds.
export function splitIntoTurns(events: ChatEvent[], startIndex: number): { index: number; events: ChatEvent[] }[] {
  const groups: { index: number; events: ChatEvent[] }[] = []
  // The kind of the last event that was part of the conversation. Snapshots
  // carry session state and can land anywhere, including between two chunks of
  // one message, so they belong to whichever turn is open but must not decide
  // where a turn begins — tracked separately rather than read off the previous
  // index for exactly that reason.
  let previousKind: ChatEvent['kind'] | undefined
  events.forEach((event, offset) => {
    if (isSnapshotEvent(event)) {
      if (groups.length > 0) {
        groups[groups.length - 1].events.push(event)
      }
      return
    }
    if (event.kind === 'user') {
      // A prompt arrives as a RUN of 'user' events — one per content delta, the
      // same way a reply does — so only the FIRST of a run opens a turn. Opening
      // one per event splits a chunked message into several turns, the leading
      // ones holding a fragment and no terminal event, which then read as cut
      // off. A run that starts the window has no predecessor to check and opens
      // a turn: a window cut cannot tell a continuation from a beginning.
      if (previousKind === 'user' && groups.length > 0) {
        groups[groups.length - 1].events.push(event)
      } else {
        groups.push({ index: startIndex + offset, events: [event] })
      }
    } else if (groups.length > 0) {
      groups[groups.length - 1].events.push(event)
    }
    previousKind = event.kind
  })
  return groups
}
