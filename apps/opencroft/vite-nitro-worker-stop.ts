import type { Plugin } from 'vite'

import { WORKER_STOP_REQUEST, WORKER_STOPPED } from './server/worker-stop'

// Nitro serves the app from a worker thread and does not end that worker when
// the dev server closes. A dev-server restart (a config change, the SSR
// watchdog) therefore leaves the old worker running beside the new one, still
// holding the embedded database. This ends the outgoing worker when its server
// closes: first the app's own stop, which stores open documents and releases
// the database, then the thread.

// The app's stop is itself bounded (its shutdown steps, then the database
// release, about 10 s together). A worker that has not answered by then is
// ended anyway, and ending the thread releases its datadir lock with it.
const STOP_TIMEOUT_MS = 12_000

// The part of nitro's dev runner this uses: it is the `devServer` of the
// `nitro` environment.
interface WorkerRunner {
  readonly ready: boolean
  sendMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): void
  offMessage(listener: (message: unknown) => void): void
  close(): Promise<void>
}

function askToStop(runner: WorkerRunner): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      runner.offMessage(listener)
      resolve()
    }
    const listener = (message: unknown) => {
      if ((message as { type?: unknown } | null)?.type === WORKER_STOPPED) {
        finish()
      }
    }
    const timer = setTimeout(finish, STOP_TIMEOUT_MS)
    runner.onMessage(listener)
    runner.sendMessage({ type: WORKER_STOP_REQUEST })
  })
}

export function nitroWorkerStop(): Plugin {
  return {
    name: 'nitro-worker-stop',
    apply: 'serve',
    applyToEnvironment: (environment) => environment.name === 'nitro',
    async closeBundle() {
      const runner = (this.environment as unknown as { devServer?: WorkerRunner }).devServer
      if (!runner) {
        return
      }
      // A runner that is not ready queues messages instead of sending them, so
      // the request would only ever reach the timeout.
      if (runner.ready) {
        await askToStop(runner)
      }
      await runner.close()
    },
  }
}
