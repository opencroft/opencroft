import type { QueueMode } from 'agent-client/types'

export interface ParsedMessage {
  /** Message body to deliver. */
  message: string
  /**
   * How this message relates to the target session's queue — `wait` to be
   * delivered on its own once the running turn ends, `push` to interrupt and
   * deliver everything held as one turn. Required in a JSON payload: sending
   * into a busy session is a choice the caller makes, not one it inherits.
   * Replaces the former `force`, which was this same interrupt-and-push.
   */
  queue: QueueMode
  /**
   * A group-chat thread reference (`<group-slug>.<agent-slug>.<thread-slug>`,
   * a whole session key, or a thread id). The only routing a send-message
   * node performs — a payload that names no thread is refused at delivery.
   */
  thread?: string
}

export function tryParseJsonMessage(text: string): ParsedMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj['message'] !== 'string') {
    return null
  }
  // Refused rather than ignored, and THROWN rather than returned as null: these
  // fields addressed direct agent sessions, a delivery path that no longer
  // exists. Silently dropping them would deliver the message somewhere the
  // caller did not name — or nowhere — without telling them why.
  const removed = ['agent', 'job', 'key', 'session'].filter((field) => field in obj)
  if (removed.length > 0) {
    throw new Error(
      `send: ${removed.map((f) => `"${f}"`).join(', ')} addressed a direct agent session, ` +
        'a delivery path that has been removed — target a group-chat thread with "thread" instead',
    )
  }
  const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  // Refused rather than defaulted, and THROWN rather than returned as null: a
  // null here means "not a payload, treat the whole thing as message text",
  // which would quietly deliver the caller's JSON as the message instead of
  // telling them what they left out.
  //
  // `force` is named specifically because it was this parameter under its old
  // name, so a caller still sending it gets pointed at its replacement rather
  // than a bare "queue is required".
  const queue = obj['queue']
  if (queue !== 'wait' && queue !== 'push') {
    const had = 'force' in obj ? ' (`force` has been replaced by `queue: "push"`)' : ''
    throw new Error(`send: "queue" is required and must be "wait" or "push"${had}`)
  }
  return {
    message: obj['message'],
    queue,
    // NO `sender`. Who a message is from is stamped by the send path, from
    // what actually fed the run, and is never read from the payload: a field
    // the caller writes is a field the caller can write wrongly, and an author
    // nobody checked makes the avatar beside it a lie rather than a fact.
    thread: optStr(obj['thread']),
  }
}
