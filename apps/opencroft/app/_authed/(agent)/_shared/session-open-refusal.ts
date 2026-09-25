import { ActionRequiredError } from 'agent-client/errors'

// An open the server refused for a reason only a person can remove: no key on
// the profile, an account that is not signed in, an agent node that is gone.
// Asking again gives the same answer, so the chat stops and shows it instead
// of retrying -- a retry is a full server-side open each time, and for some
// harnesses that means spawning a process only to be refused again.
//
// It crosses the RPC boundary as DATA, not as a thrown error. A thrown error
// reaches the browser rebuilt from its message alone (the server-function
// serializer keeps nothing else), so its class -- the one fact that says
// "don't retry" -- would not survive the trip.
//
// Free of server imports for the reason send-refused-error.ts gives: the server
// functions return it, the transports read it, and use-acp-session.ts imports
// server functions. agent-client's errors module is plain classes, safe on
// both sides.

/** What an open server function answers with in place of a session it was refused. */
export interface SessionOpenRefusal {
  refused: string
}

/**
 * Run a server-side open, answering a refusal as data and letting every other
 * failure throw as before.
 */
export async function refusalAsData<T>(open: () => Promise<T>): Promise<T | SessionOpenRefusal> {
  try {
    return await open()
  } catch (error) {
    if (error instanceof ActionRequiredError) {
      return { refused: error.message }
    }
    throw error
  }
}

/**
 * What an open transport throws for a refusal, so the hook can tell it from a
 * failure worth retrying. Constructed and read in the browser, so `instanceof`
 * holds.
 */
export class SessionOpenRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionOpenRefusedError'
  }
}

/** The opened session, or the refusal thrown as a SessionOpenRefusedError. */
export function openedOrThrow<T extends object>(answer: T | SessionOpenRefusal): T {
  if (isRefusal(answer)) {
    throw new SessionOpenRefusedError(answer.refused)
  }
  return answer
}

// Own property only: `in` would also find a `refused` on the prototype chain.
function isRefusal(answer: object): answer is SessionOpenRefusal {
  return Object.hasOwn(answer, 'refused')
}
