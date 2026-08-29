import { SessionManager } from './session-manager'

/**
 * The one live session registry for this process.
 *
 * It lives in its own module because two places need the SAME registry and neither may own it:
 * `socket.ts`, which serves client messages, and `job-session.ts`, which starts sessions from
 * server code. A second `new SessionManager()` anywhere would be a second, invisible pool — the
 * capacity limits would each be enforced over half the sessions, and a client could never attach
 * to a job because it would be looking in the other map.
 *
 * Deliberately not re-exported from the package's public entry point. Anything outside this
 * package that could reach the registry directly could attach a session to an arbitrary peer, or
 * start one from a request handler; the exported surface is the socket handler and the job entry,
 * both of which decide those things themselves.
 */
export const sessionManager = new SessionManager()
