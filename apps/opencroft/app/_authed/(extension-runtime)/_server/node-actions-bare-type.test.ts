// An extension's server module is keyed, and told, by the bare types it
// declared, while the graph stores them qualified. End to end through the
// loader: a local extension written into a scratch data dir, its server module
// written as a build would leave it, so nothing compiles.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { createHost } from './host'
import { dispatchNodeActionImpl, getNodeActionAccess } from './node-actions-impl'

const suffix = crypto.randomUUID().slice(0, 8)
const root = mkdtempSync(join(tmpdir(), 'node-actions-bare-'))
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

const FOLDER = `local.gauges-${suffix}`
mkdirSync(join(root, 'extensions', FOLDER, 'dist'), { recursive: true })
writeFileSync(
  join(root, 'extensions', FOLDER, 'extension.json'),
  JSON.stringify({
    name: 'Gauges',
    version: '0.0.0',
    nodes: [
      { type: 'gauge', name: 'Gauge', handles: [{ id: 'out', role: 'source', handleType: 'signal' }] },
      { type: 'panel', name: 'Panel' },
    ],
  }),
)
// Everything keyed and compared by the bare names above.
writeFileSync(
  join(root, 'extensions', FOLDER, 'dist', 'server.js'),
  `module.exports = {
  exposeOutput: (handleId, data, type) => (type === 'gauge' ? { told: type } : undefined),
  nodeActions: {
    gauge: {
      whoami: async (ctx) => ({
        type: ctx.type,
        typeId: ctx.typeId,
        inside: ctx.containingNodes('panel').map((node) => node.type),
      }),
    },
  },
  nodeActionAccess: { gauge: { whoami: 'admin' } },
}
`,
)

const registry = getSpacesRegistry()
await registry.ensureLoaded()
const slug = `node-actions-bare-${suffix}`
const GAUGE = `gauge-${suffix}`
await registry.create(slug, slug, {
  nodes: [
    {
      id: `panel-${suffix}`,
      type: qualifyType(FOLDER, 'panel'),
      position: { x: 0, y: 0 },
      style: { width: 500, height: 500 },
      data: {},
    },
    { id: GAUGE, type: qualifyType(FOLDER, 'gauge'), position: { x: 10, y: 10 }, data: {} },
  ],
  edges: [],
})

test("a node action is found under the node's bare type, and told it", async () => {
  assert.deepEqual(await dispatchNodeActionImpl({ nodeId: GAUGE, actionId: 'whoami' }), {
    type: 'gauge',
    typeId: 'gauge',
    inside: [qualifyType(FOLDER, 'panel')],
  })
})

test("the action's access policy is read under the bare type too", async () => {
  assert.equal(await getNodeActionAccess(GAUGE, 'whoami'), 'admin')
})

test("exposeOutput is told the bare type when the host resolves the node's output", async () => {
  assert.deepEqual(await createHost('acme.reader').terminal.getContext(GAUGE, 'out'), { told: 'gauge' })
})
