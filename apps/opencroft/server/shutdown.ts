// Stopping the server without losing what the database was holding.
//
// An embedded database persists what it holds when its driver is released, so a
// process that is killed without releasing it can lose its most recent writes.
// Nothing here is on any request path: this runs once, when the supervisor asks
// the process to stop.

import { closeDb } from '@opencroft/db'

const globalForShutdown = globalThis as unknown as {
  __opencroftShutdownRegistered?: boolean
  __opencroftShutdownSteps?: Array<() => Promise<void>>
}

/**
 * Register work to run when the process is asked to stop, BEFORE the database
 * is released — so a step may still write. Steps run in registration order;
 * a failing step is logged and does not block the others or the exit.
 * Idempotence is the caller's concern. On the same global as the registered
 * flag, for the same reason: dev-server module reloads must not fork the list.
 */
export function registerShutdownStep(step: () => Promise<void>): void {
  const steps = (globalForShutdown.__opencroftShutdownSteps ??= [])
  steps.push(step)
}

// Bounded for the same reason releaseDatabase is: a hung step is a reason to
// exit late, never a reason not to exit.
const STEPS_TIMEOUT_MS = 5_000

async function runShutdownSteps(): Promise<void> {
  const all = (async () => {
    for (const step of globalForShutdown.__opencroftShutdownSteps ?? []) {
      try {
        await step()
      } catch (error) {
        console.error('[shutdown] step failed', error)
      }
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[shutdown] steps did not finish within ${STEPS_TIMEOUT_MS}ms; continuing`)
        resolve()
      }, STEPS_TIMEOUT_MS)
    }),
  ])
  clearTimeout(timer)
}

// Signals a supervisor uses to ask for a stop: SIGTERM from a container runtime,
// SIGINT from a terminal. Both mean the same thing here.
const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const

// How long the stop may spend releasing the database before the process leaves
// anyway. A database that will not close is a reason to exit late, never a
// reason not to exit: the supervisor's next step is SIGKILL, and being killed
// part-way through a flush is the state this exists to avoid. Without the
// bound, a hung close would turn "stopped uncleanly" into "never stopped".
const CLOSE_TIMEOUT_MS = 5_000

async function releaseDatabase(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closeDb(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(`[shutdown] database did not close within ${CLOSE_TIMEOUT_MS}ms; exiting anyway`)
          resolve()
        }, CLOSE_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    // Logged rather than rethrown: the process is leaving either way, and an
    // unhandled rejection here would replace a clear message with a stack from
    // somewhere else entirely.
    console.error('[shutdown] releasing the database failed', error)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Release the database when the process is asked to stop.
 *
 * Idempotent — registering twice would run the stop twice.
 *
 * Registered from the same boot step that starts the schedulers, and that
 * pairing is deliberate: the writers and the thing that flushes their writes
 * come up together, so a process that never booted far enough to write also
 * never needs to close.
 */
export function registerShutdownHandlers(): void {
  if (globalForShutdown.__opencroftShutdownRegistered) {
    return
  }
  globalForShutdown.__opencroftShutdownRegistered = true

  for (const signal of STOP_SIGNALS) {
    process.once(signal, () => {
      void (async () => {
        await runShutdownSteps()
        await releaseDatabase()
        // Explicit, and it is the reason this handler cannot simply do its work
        // and return: registering ANY listener for these signals replaces the
        // default behaviour of terminating. A handler that does not exit leaves
        // the process alive until the supervisor escalates to SIGKILL — the
        // unclean stop this whole module exists to prevent, reintroduced by the
        // fix for it.
        process.exit(0)
      })()
    })
  }
}
