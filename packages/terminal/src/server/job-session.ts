import { randomBytes } from 'node:crypto'

import type { TerminalContext } from '../types'
import { getBackend, type StreamOptions } from './backend'
import { sessionManager } from './manager'

/**
 * Server-started jobs, watchable from the browser through the ordinary terminal session.
 *
 * ─── THIS ENTRY POINT IS FOR SERVER CODE AND MUST STAY THAT WAY ───
 *
 * `startJobSession` runs a command its caller chooses, and hands back a key that authorises
 * attaching to it. If any client message could reach it — a new `case` in socket.ts's switch, a
 * route handler forwarding a request body — that would be arbitrary command execution by anyone
 * holding a session cookie. The protection is not that no such case exists today; it is that this
 * module is never imported by the message path, and `job-session-isolation.test.ts` fails the
 * build if that changes. Read that test before adding a socket message that starts anything.
 *
 * The session key is a random token rather than something a caller supplies, and it is the only
 * way to reach the job: a key is the whole authorisation to attach to a session, so a guessable
 * one would put the job's output — and a write channel into it — within reach of anyone who
 * could guess it.
 *
 * ─── IT IS TOLD ITS CONTEXT, AND SO IT CAN REFUSE ───
 *
 * The command goes out through `getBackend(ctx).stream(…)`, the same dispatch every one-shot exec
 * uses, so a job meant for a node that reaches a docker daemon somewhere else runs there and not
 * here. A context with no streaming channel of its own — `wsl`, `docker-exec` — is refused by that
 * dispatch, naming the context. That is the difference between this and a function that spawns
 * locally whatever it is handed: this one is told, so "wrong host, quietly, with a session key
 * handed back as though it had worked" is not a state it can reach.
 *
 * ─── AND NO TRANSPORT HERE USES A PTY ───
 *
 * A pty echoes whatever is written to its stdin straight back to the reader. A job whose input is
 * a document — a compose file on `-f -`, a script on stdin — would therefore print that document
 * to everyone watching, and those documents are exactly where resolved secret values live. Both
 * implemented transports are non-pty (a pipe locally, ssh's `exec` channel rather than `shell`),
 * so what a watcher receives is the process's own output and nothing else.
 */

export interface JobSessionOptions extends StreamOptions {
  command: string
  args?: string[]
  /**
   * Stop the command once nobody has watched it for this long. The clock starts when the job
   * starts (nobody is watching yet) and again whenever its last watcher leaves.
   *
   * For a job that exists only to be looked at, such as following a log. Such a job never ends
   * on its own, and without a bound, abandoned viewers hold job slots until the lifetime limit,
   * so the next job that does real work is refused. Leave it unset for a job whose work matters
   * whether or not anyone watches, such as a deploy.
   */
  stopWhenUnwatchedMs?: number
}

export interface JobSession {
  /** Hand this to the client; it is what `<Terminal sessionKey=…/>` attaches to. Unguessable. */
  sessionKey: string
  sessionId: string
}

/**
 * How long a job may run before it is stopped.
 *
 * Thirty minutes, and the number is defensible in both directions rather than round. Below it sit
 * the jobs this exists for: the longest deploy measured on these hosts is an image build of a few
 * minutes, so a bound an order of magnitude above that does not truncate real work. Above it sits
 * nothing that should be running here at all — a command still going after half an hour is wedged,
 * waiting on input it will never get, and the alternative to a bound is that it holds one of ten
 * job slots and a pooled connection for the life of the server process.
 *
 * **The behaviour at the bound is defined and visible.** The command is killed and the reason is
 * written into the stream first, so a watcher sees why the output stopped. Reaching the bound
 * silently would be indistinguishable from the deploy tool hanging, which is the diagnosis it
 * would then get.
 */
export const MAX_JOB_LIFETIME_MS = 30 * 60 * 1000

/**
 * Start a command as a watchable session and return the key a client can attach to.
 *
 * Server code only — see the module comment above.
 */
export async function startJobSession(ctx: TerminalContext, opts: JobSessionOptions): Promise<JobSession> {
  const slot = sessionManager.prepareJob()
  if (!slot.ok) {
    throw new Error(slot.message)
  }

  const { command, args, stopWhenUnwatchedMs, ...streamOpts } = opts
  // Refusals from an unsupported context, and transport failures (host unreachable, auth), come
  // back as a rejection here — before a key exists. A caller that gets one has nothing to clean
  // up and nothing to tell a watcher about, which is why the slot is the only thing reserved
  // ahead of it.
  const handle = await getBackend(ctx).stream(ctx, [command, ...(args ?? [])], streamOpts)

  // 32 hex characters. The key is the whole authorisation to attach, so it is generated here and
  // never derived from anything a caller could also compute (a node id, a service name).
  const sessionKey = `job:${randomBytes(16).toString('hex')}`
  const session = sessionManager.create(null, handle, { sessionKey, kind: 'job', stopWhenUnwatchedMs })

  const bound = setTimeout(() => {
    handle.emit(`\nStopped after ${MAX_JOB_LIFETIME_MS / 60000} minutes: this job reached its time limit.\n`)
    handle.kill()
  }, MAX_JOB_LIFETIME_MS)
  // The timer must not be the reason the process stays up: a job that finishes in a second would
  // otherwise hold the event loop open for the rest of the half hour.
  bound.unref?.()
  handle.onExit(() => clearTimeout(bound))

  return { sessionKey, sessionId: session.id }
}
