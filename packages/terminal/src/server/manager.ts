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
 *
 * It is kept on `globalThis` because this module can be loaded more than once in one process: the
 * dev server evaluates the websocket route and server functions in separate module runners, and a
 * production build bundles the package into more than one output. Each copy of the module then
 * finds the registry the first one made, and only that first copy constructs one, so there is one
 * sweep timer too. The cost is on the development side: a hot reload of `session-manager.ts` keeps
 * the instance built from the old class, so a change there takes effect only after a restart.
 */
const REGISTRY_KEY = Symbol.for('opencroft.terminal.sessionManager')

const registryHolder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: SessionManager }

registryHolder[REGISTRY_KEY] ??= new SessionManager()

export const sessionManager: SessionManager = registryHolder[REGISTRY_KEY]
