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

/** Shown when a send fails for anything that is not a deliberate refusal. */
export const GENERIC_SEND_FAILURE = 'Your message could not be sent. It has been put back in the composer.'

/**
 * The copy for a failed send: a refusal speaks for itself, anything else gets
 * the generic wording.
 */
export function sendFailureMessage(error: unknown): string {
  return error instanceof SendRefusedError ? error.message : GENERIC_SEND_FAILURE
}
