#!/usr/bin/env node

// A boot-and-answer check, meant to run after a fresh, real install rather
// than against whatever node_modules already happens to be on disk -- a
// scoped `npm install`/`npm ci` run from within one workspace member's own
// directory only links the workspace dependencies THAT package.json
// declares, which is not the same guarantee a root-level install gives. A
// module graph that is statically well-typed says nothing about whether
// Node can actually resolve it at runtime from that narrower install; only
// starting the real process and requiring an answer does. This script does
// not perform the install itself -- the caller runs it first, the same way
// the target deployment does, then this boots the real entrypoint (`npm run
// dev`) and requires one route to answer before treating it as working.

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9999
const ROUTE = '/api/build-info'
const BOOT_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 500

function collectOutput(child) {
  const chunks = []
  child.stdout.on('data', (d) => chunks.push(d))
  child.stderr.on('data', (d) => chunks.push(d))
  return () => Buffer.concat(chunks).toString('utf8')
}

// Vite's dev server accepts connections before its SSR environment is ready,
// and a request in that window fails with this message instead of reaching
// the app. It means "not up yet", not a broken module graph. The name is
// quoted differently in a JSON body (\"ssr\") and an HTML overlay, hence \S+.
const NOT_READY = /Vite environment \S+ is unavailable/

async function waitForRoute(url, deadline) {
  let last = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      const body = await res.text().catch(() => '(no body)')
      last = { ok: res.ok, status: res.status, body }
      if (res.ok) return last
      // Any other unhealthy answer (e.g. a 500 from the exact resolution
      // failure this check exists to catch) is a real answer, so stop polling
      // and report it.
      if (!NOT_READY.test(body)) return last
    } catch {
      // Not listening yet -- keep polling until the deadline.
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return last
}

async function main() {
  console.log(`[smoke-check] booting the real entrypoint (npm run dev) on port ${PORT}...`)
  // `npm run dev` execs a shell that execs vite, so it can be two processes
  // deep by the time it's actually listening. `detached: true` puts the whole
  // chain in its own process group; killing that group (the negative pid) is
  // what actually reaches vite, where killing just the `child` handle only
  // ever reached the outermost process and left vite running past this
  // script's exit, holding the port for whatever ran next.
  const child = spawn('npm', ['run', 'dev'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const getOutput = collectOutput(child)

  let childExited = false
  child.once('exit', () => {
    childExited = true
  })

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    const res = await waitForRoute(`http://127.0.0.1:${PORT}${ROUTE}`, deadline)

    if (childExited) {
      console.error(`[smoke-check] the server process exited before ${ROUTE} ever answered.`)
      console.error(getOutput())
      process.exitCode = 1
      return
    }

    if (!res) {
      console.error(`[smoke-check] timed out after ${BOOT_TIMEOUT_MS}ms waiting for ${ROUTE} to answer.`)
      console.error(getOutput())
      process.exitCode = 1
      return
    }

    if (!res.ok) {
      console.error(`[smoke-check] ${ROUTE} answered with ${res.status}, not 200.`)
      // A dev-mode SSR crash renders vite's full HTML error overlay -- the
      // real message is a few lines in, buried in a page of markup. The
      // server's own stdout/stderr (below) has the same failure as a plain
      // stack trace, so the response body only needs to prove one was sent.
      const { body } = res
      console.error(body.length > 2000 ? `${body.slice(0, 2000)}\n... (${body.length} chars total, truncated)` : body)
      console.error(getOutput())
      process.exitCode = 1
      return
    }

    console.log(`[smoke-check] ${ROUTE} answered ${res.status} -- the real entrypoint boots after a fresh install.`)
  } finally {
    if (!childExited && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Group already gone.
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
  // Belt-and-suspenders: a killed process group can leave a lingering pipe or
  // handle that would otherwise hold this script's own event loop open past
  // its actual work, hanging whatever invoked it (a CI step waiting on this
  // process to exit) even though the check itself already has its answer.
  process.exit(process.exitCode ?? 0)
}
