import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { before, test } from 'node:test'

import type { ProbeRequest, ProbeResult } from './attachment-routing.probe'

// The transcript draws a sent picture with an <img>, and every <img> request
// carries `Sec-Fetch-Dest: image`. Under `vite dev` -- the dev server -- Nitro's
// dev middleware takes any such request for a static asset unless the URL is a
// route of its own, and a static asset that is not on disk is an HTML 404
// "Cannot GET". That is how a picture route that answered every fetch() still
// drew as a file name in the chat.
//
// So this boots the real thing -- Vite with the Nitro plugin over this app's
// own server directory, in attachment-routing.probe.ts -- and asks the way a
// browser drawing the picture asks. No session is sent: the route answering
// its JSON 401 is the proof it was reached, since the static fallback answers
// nothing but an HTML 404.
//
// The control is what keeps this honest: a path Nitro does not route, asked
// for as an image, must still get the HTML 404. If it did not, the header would
// no longer be doing anything here and the first assertion would prove nothing.

// The app's icons and its manifest ride on the same rule: a browser asks for an
// icon as an image and for the manifest as a `manifest`, so they are Nitro
// routes too, and are probed here the way a browser asks for them.

const PICTURE = '/api/acp/attachments/att-1?key=space.agent.thread'
const NOT_A_ROUTE = '/api/acp/not-a-route/att-1'
const TAB_ICON = '/favicon.svg?color=green'
const APP_ICON = '/icons/icon-192.png?color=green'
const MANIFEST = '/manifest.webmanifest?color=green'

const REQUESTS: ProbeRequest[] = [
  { path: PICTURE, dest: 'image' },
  { path: PICTURE, dest: 'empty' },
  { path: NOT_A_ROUTE, dest: 'image' },
  { path: TAB_ICON, dest: 'image' },
  { path: APP_ICON, dest: 'image' },
  { path: MANIFEST, dest: 'manifest' },
]

let results: ProbeResult[]

before(async () => {
  results = await runProbe(REQUESTS)
})

function resultFor(path: string, dest: string): ProbeResult {
  const result = results.find((r) => r.path === path && r.dest === dest)
  assert.ok(result, `probed ${dest} ${path}`)
  return result
}

test('a picture requested the way an <img> requests it reaches the attachment route', () => {
  const result = resultFor(PICTURE, 'image')
  assert.equal(result.status, 401, 'the route answered, behind its session gate')
  assert.match(result.contentType, /json/)
})

test('and so does the same request from fetch()', () => {
  assert.equal(resultFor(PICTURE, 'empty').status, 401)
})

test('control: a path Nitro does not route, asked for as an image, is still diverted as a static asset', () => {
  const result = resultFor(NOT_A_ROUTE, 'image')
  assert.equal(result.status, 404)
  assert.match(result.contentType, /html/)
})

test('the tab icon, an app icon and the manifest reach their routes when a browser asks for them', () => {
  for (const [path, dest, type] of [
    [TAB_ICON, 'image', /^image\/svg\+xml/],
    [APP_ICON, 'image', /^image\/png/],
    [MANIFEST, 'manifest', /^application\/manifest\+json/],
  ] as const) {
    const result = resultFor(path, dest)
    assert.equal(result.status, 200, `${dest} ${path}`)
    assert.match(result.contentType, type, `${dest} ${path}`)
  }
})

// Its own process GROUP, killed whole at the end: Nitro's dev worker is a
// process of its own under the probe, and one left behind keeps holding the
// probe's database.
async function runProbe(requests: ProbeRequest[]): Promise<ProbeResult[]> {
  const port = await freePort()
  const probe = new URL('./attachment-routing.probe.ts', import.meta.url).pathname
  const child = spawn('npx', ['tsx', probe, JSON.stringify(requests), String(port)], {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const killGroup = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  const timer = setTimeout(killGroup, 60_000)
  try {
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
  } finally {
    clearTimeout(timer)
    killGroup()
  }
  const line = stdout.split('\n').find((l) => l.startsWith('PROBE '))
  assert.ok(line, `the probe reported its results\n--- stdout\n${stdout}\n--- stderr\n${stderr}`)
  return JSON.parse(line.slice('PROBE '.length)) as ProbeResult[]
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port')),
      )
    })
  })
}
