// What a node action writes back to its node (its errors, its data patch)
// is announced the way every graph write is: a `graph_updated` for the space,
// once per burst of writes. A run that changes nothing writes nothing. End to
// end through the loader, with a local extension written into a scratch data
// dir.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, afterEach, beforeEach } from 'node:test'

import { qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { toastStore } from '@/lib/toast-store'
import { dispatchNodeActionImpl } from './node-actions-impl'

const suffix = crypto.randomUUID().slice(0, 8)
const root = mkdtempSync(join(tmpdir(), 'node-action-writes-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = root
after(() => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  rmSync(root, { recursive: true, force: true })
})

const FOLDER = `local.lamps-${suffix}`
mkdirSync(join(root, 'extensions', FOLDER, 'dist'), { recursive: true })
writeFileSync(
  join(root, 'extensions', FOLDER, 'extension.json'),
  JSON.stringify({ name: 'Lamps', version: '0.0.0', nodes: [{ type: 'lamp', name: 'Lamp' }] }),
)
writeFileSync(
  join(root, 'extensions', FOLDER, 'dist', 'server.js'),
  `module.exports = {
  nodeActions: {
    lamp: {
      ok: async () => 'ok',
      fail: async (ctx) => { throw new Error(ctx.params.message) },
      paint: async (ctx) => { ctx.updateData({ colour: ctx.params.colour }) },
    },
  },
}
`,
)

const registry = getSpacesRegistry()
await registry.ensureLoaded()
const slug = `node-action-writes-${suffix}`
const LAMP = `lamp-${suffix}`
await registry.create(slug, slug, {
  nodes: [{ id: LAMP, type: qualifyType(FOLDER, 'lamp'), position: { x: 0, y: 0 }, data: {} }],
  edges: [],
})

function storedData(): Record<string, unknown> {
  const node = registry.resolveGraph(slug)?.graph.graph.nodes.find((n) => (n as { id: string }).id === LAMP) as
    | { data?: Record<string, unknown> }
    | undefined
  return node?.data ?? {}
}

function storedVersion(): string | undefined {
  return registry.resolveGraph(slug)?.graph.updatedAt.toISOString()
}

let events: string[] = []
let unsubscribe = () => {}
beforeEach(() => {
  events = []
  unsubscribe = toastStore.subscribe((line) => {
    events.push((JSON.parse(line.replace(/^data: /, '')) as { type: string }).type)
  }, slug)
})
afterEach(() => unsubscribe())

// A burst of writes is announced once, shortly after it: the events seen once
// the first has arrived.
async function announcements(): Promise<string[]> {
  const deadline = Date.now() + 10_000
  while (events.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return events
}

async function dispatchFailing(message: string): Promise<void> {
  await assert.rejects(dispatchNodeActionImpl({ nodeId: LAMP, actionId: 'fail', params: { message } }), { message })
}

test('a failing action stores its error and announces the graph change', async () => {
  await dispatchNodeActionImpl({ nodeId: LAMP, actionId: 'ok' })
  events = []
  await dispatchFailing('lamp is broken')
  assert.deepEqual(storedData().__errors, ['lamp is broken'])
  assert.deepEqual(await announcements(), ['graph_updated'])
})

test('the next action that succeeds clears the error and announces it', async () => {
  await dispatchFailing('lamp is broken')
  await announcements()
  events = []
  assert.equal(await dispatchNodeActionImpl({ nodeId: LAMP, actionId: 'ok' }), 'ok')
  assert.equal('__errors' in storedData(), false)
  assert.deepEqual(await announcements(), ['graph_updated'])
})

test('an action that succeeds on a node with no error writes nothing', async () => {
  await dispatchNodeActionImpl({ nodeId: LAMP, actionId: 'ok' })
  const version = storedVersion()
  await dispatchNodeActionImpl({ nodeId: LAMP, actionId: 'ok' })
  // Every change to the graph moves its version at once, so an unchanged
  // version is the whole check that nothing was written.
  assert.equal(storedVersion(), version)
})

test('a retry clears the error while it runs and stores it again when it fails, announced once', async () => {
  await dispatchFailing('lamp is broken')
  await announcements()
  events = []
  const version = storedVersion()
  await dispatchFailing('lamp is broken')
  assert.notEqual(storedVersion(), version)
  assert.deepEqual(storedData().__errors, ['lamp is broken'])
  assert.deepEqual(await announcements(), ['graph_updated'])
})

test("an action's data patch is stored and announced", async () => {
  await dispatchNodeActionImpl({ nodeId: LAMP, actionId: 'ok' })
  await announcements()
  events = []
  await dispatchNodeActionImpl({ nodeId: LAMP, actionId: 'paint', params: { colour: 'amber' } })
  assert.equal(storedData().colour, 'amber')
  assert.deepEqual(await announcements(), ['graph_updated'])
})
