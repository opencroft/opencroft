import { errorMessage } from 'agent-client/errors'
import { knownFailure, type PlainFailure, plainFailure } from 'agent-client/plain-failure'

// A send that was deliberately refused, carrying copy meant for the reader.
//
// Dependency-free and in _shared for the same reason the group-chat refusal
// type is: both sides need to name it -- a send transport throws it, the chat
// hook reads it -- and use-acp-session.ts imports server functions, so anything
// that had to reach this type through that module would drag the whole tail
// along for a class with no behaviour.
//
// A transport throws this when the server said no for a reason the reader can
// act on ("that agent is no longer a member"). Anything else out of a
// transport is a fault rather than an answer and gets generic wording instead,
// because an arbitrary error's message is written for whoever reads a log.
//
// The distinction is the transport's to make, not the hook's: the hook does not
// know which server function it was handed or what its refusals mean, and
// teaching it would put one screen's vocabulary into every screen's send path.
//
// Constructed in the browser and read in the browser -- it never crosses the
// RPC boundary -- so `instanceof` is reliable here, unlike GroupChatAccessError
// (see that type's note on seroval).
export class SendRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SendRefusedError'
  }
}

/**
 * The notice for a failed send: a refusal speaks for itself, anything else is
 * read in plain words (agent-client's plainFailure) with its own text kept
 * under Details. What a harness says about a delivered prompt reaches the
 * conversation as an event, so the text a send throws is the engine's.
 */
export function sendFailureNotice(error: unknown): PlainFailure {
  return error instanceof SendRefusedError
    ? { title: error.message }
    : plainFailure(errorMessage(error), 'send', 'engine')
}

/**
 * The notice on a sent message that stays on screen, not sent, with Send again
 * and Discard beside it. Its words are not in the composer, so the general
 * send hint, which sends the reader there, is left off; a hint from a rule
 * that knows the cause names that cause's remedy and is kept.
 */
export function outgoingFailureNotice(error: unknown): PlainFailure {
  const notice = sendFailureNotice(error)
  if (error instanceof SendRefusedError || knownFailure(errorMessage(error), 'engine')) {
    return notice
  }
  return { title: notice.title, ...(notice.details ? { details: notice.details } : {}) }
}
