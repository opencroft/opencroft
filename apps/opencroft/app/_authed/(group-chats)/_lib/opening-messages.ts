// A new thread's opening message, carried from the start composer to the
// thread's own chat.
//
// Starting a thread creates it and nothing more (see mintThreadForPerson); the
// thread's chat then opens its session and sends this through its ordinary
// send, so the start and anything that goes wrong with it happen where the
// reader is looking. Held in memory for the hand-over between the two
// screens, which is one navigation: the thread's chat takes it as it mounts.
//
// The selection travels beside the text, not inside it: it is the one the
// start composer quoted when the reader pressed send, and the thread's send
// attaches it, once, in place of whatever its own scope holds by then (the
// chats page mounts a new scope for the thread's route).

/** What a new thread opens with. */
export interface OpeningMessage {
  /** What the reader typed. */
  text: string
  /** The selection's content, when one was quoted and passing was on. */
  selection?: string
}

const opening = new Map<string, OpeningMessage>()

/** Hold `message` for the thread `threadId` opens with. An empty start holds nothing. */
export function holdOpeningMessage(threadId: string, message: OpeningMessage): void {
  if (message.text) {
    opening.set(threadId, message)
  }
}

/** The message `threadId` opens with, once: taking it removes it. */
export function takeOpeningMessage(threadId: string): OpeningMessage | undefined {
  const message = opening.get(threadId)
  opening.delete(threadId)
  return message
}
