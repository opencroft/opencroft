import type { Plugin, ViteDevServer } from 'vite'

// The nitro dev worker can boot with a dead module-runner transport (a race
// during server start or in-process restart). Symptoms: 503 'Vite environment
// "ssr" is unavailable' while the SSR entry import is pending, then the import
// fails with 'vite:invoke timed out after 60000ms' and nitro caches that error
// for every request. A full-reload does NOT recover (the transport is dead) —
// only a dev server restart does, so this watchdog probes and restarts.
const DEAD_TRANSPORT = 'invoke timed out after'
const ENV_UNAVAILABLE = 'is unavailable'
const PROBE_INTERVAL = 15_000
// 'unavailable' alone is normal while a slow boot is still importing the SSR
// entry; only treat it as wedged after it persists past the 60s invoke timeout.
const MAX_UNAVAILABLE_PROBES = 6
const MAX_RESTARTS = 3

interface WatchdogState {
  restarts: number
}

function state(): WatchdogState {
  const g = globalThis as { __ssrWatchdog?: WatchdogState }
  g.__ssrWatchdog ??= { restarts: 0 }
  return g.__ssrWatchdog
}

async function probe(port: number): Promise<'healthy' | 'unavailable' | 'wedged'> {
  try {
    const res = await fetch(`http://localhost:${port}/`, { redirect: 'manual' })
    if (res.status < 500) {
      return 'healthy'
    }
    const body = await res.text()
    if (body.includes(DEAD_TRANSPORT)) {
      return 'wedged'
    }
    if (body.includes(ENV_UNAVAILABLE)) {
      return 'unavailable'
    }
    return 'healthy'
  } catch {
    return 'healthy'
  }
}

function watch(server: ViteDevServer, port: number) {
  let unavailable = 0
  const timer = setInterval(async () => {
    const status = await probe(port)
    if (status === 'healthy') {
      unavailable = 0
      state().restarts = 0
      return
    }
    unavailable = status === 'unavailable' ? unavailable + 1 : 0
    if (status === 'unavailable' && unavailable < MAX_UNAVAILABLE_PROBES) {
      return
    }
    clearInterval(timer)
    if (state().restarts >= MAX_RESTARTS) {
      server.config.logger.error('[ssr-watchdog] SSR environment still wedged after restarts — restart the dev server manually')
      return
    }
    state().restarts += 1
    server.config.logger.warn(`[ssr-watchdog] SSR dev worker is wedged (dead vite transport) — restarting dev server (${state().restarts}/${MAX_RESTARTS})`)
    await server.restart()
  }, PROBE_INTERVAL)
  timer.unref()
  server.httpServer?.once('close', () => clearInterval(timer))
}

export function ssrWatchdog(): Plugin {
  return {
    name: 'ssr-watchdog',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address()
        if (typeof addr === 'object' && addr) {
          watch(server, addr.port)
        }
      })
    },
  }
}
