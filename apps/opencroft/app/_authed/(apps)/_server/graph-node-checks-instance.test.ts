// A node check that reads other graphs through its instance view
// (`NodeCheckInstance`), reached through the graph's write actions on real
// graphs, with a fixture extension whose server module declares the check.
//
// Pinned: a write on one graph raises or clears the finding stored on a node
// of another graph that nobody writes: by adding a node, changing it, moving
// an edge at it, removing it, and deleting the graph that holds it. A finding
// naming another graph follows that graph to a new address. Once settled, the
// graphs stop being written.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { renameSpaceAppImpl, transferSpaceAppImpl } from '@/app/_authed/(apps)/_server/runtime'
import { qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { readNodeErrors } from '@/app/_authed/(extension-runtime)/_node-errors'
import { loadSpaceGraphImpl, renameSpaceImpl } from '@/app/_authed/(space)/_server/actions-impl'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)

// A scratch data dir, so no extension installed on the machine joins in.
const root = mkdtempSync(join(tmpdir(), 'graph-node-checks-instance-'))
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

// `twin` finds the other twins of its label on other graphs, listed by graph
// address in a stable order, each marked when an edge reaches it. `plain` has
// no check: it is the other end of such an edge.
const FOLDER = `local.twins-${suffix}`
mkdirSync(join(root, 'extensions', FOLDER, 'server'), { recursive: true })
writeFileSync(
  join(root, 'extensions', FOLDER, 'extension.json'),
  JSON.stringify({
    id: FOLDER,
    name: `Twins ${suffix}`,
    version: '0.0.0',
    nodes: [
      { type: 'twin', name: 'Twin' },
      { type: 'plain', name: 'Plain' },
    ],
  }),
)
writeFileSync(
  join(root, 'extensions', FOLDER, 'server', 'index.ts'),
  `export const nodeChecks = {
  twin: (node: { id: string; data: { label?: string } }, _edges: unknown, instance: { nodesOfType(t: string): { id: string; data: { label?: string }; graph: string; edges: unknown[] }[] }) => {
    const twins = instance
      .nodesOfType('twin')
      .filter((other) => other.id !== node.id && other.data.label === node.data.label)
      .map((other) => (other.edges.length > 0 ? \`\${other.graph} (wired)\` : other.graph))
      .sort()
    return twins.length === 0 ? [] : [{ title: 'Has a twin', detail: twins.join(', ') }]
  },
}
`,
)
const TWIN = qualifyType(FOLDER, 'twin')
const PLAIN = qualifyType(FOLDER, 'plain')

const registry = getSpacesRegistry()
await registry.ensureLoaded()

async function emptyGraph(name: string): Promise<{ slug: string; app: string }> {
  const space = await registry.create(`${name}-${suffix}`, `${name}-${suffix}`, { nodes: [], edges: [] })
  const [graph] = registry.graphsOf(space.slug)
  assert.ok(graph, 'the space has its default graph')
  return { slug: space.slug, app: `${space.slug}.${graph.slug}` }
}

async function call(app: string, action: string, params: Record<string, unknown>) {
  const result = await handleToolCall('app_call', { app, action, params }, { internal: true })
  const text = (result.content as { text: string }[])[0]?.text ?? ''
  assert.notEqual(result.isError, true, `${action}: ${text}`)
  return JSON.parse(text)
}

async function createTwin(app: string, label: string): Promise<string> {
  const [created] = (await call(app, 'createNodes', { nodes: [{ type: TWIN, data: { label } }] })) as { id: string }[]
  return created.id
}

async function createPlain(app: string): Promise<string> {
  const [created] = (await call(app, 'createNodes', { nodes: [{ type: PLAIN, data: {} }] })) as { id: string }[]
  return created.id
}

/** Moves the start of the edge leaving `from` to `to`, in one write. */
async function rewire(app: string, from: string, to: string): Promise<void> {
  await mutateLiveGraph(app, { kind: 'system', name: 'rewire' }, (graph) => {
    const edge = graph.edges.find((e) => e.source === from)
    assert.ok(edge, `an edge leaves ${from}`)
    edge.source = to
  })
}

async function storedFinding(app: string, nodeId: string): Promise<string | null> {
  const loaded = await loadSpaceGraphImpl(app)
  assert.ok(loaded, `${app} loads`)
  const node = (loaded.graph.nodes as unknown as { id: string; data: Record<string, unknown> }[]).find(
    (n) => n.id === nodeId,
  )
  assert.ok(node, `${nodeId} is on ${app}`)
  const found = readNodeErrors(node.data).filter((e) => e.source === 'check')
  return found.length === 0 ? null : (found[0].detail ?? '')
}

/** Waits until the finding stored on `nodeId` is `expected`, failing after `ms`. */
async function settles(app: string, nodeId: string, expected: string | null, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  let last = await storedFinding(app, nodeId)
  while (last !== expected && Date.now() < until) {
    // biome-ignore lint/plugin/noTestFixedTime: poll interval of a wait-until-deadline loop; the deadline only bounds failure
    await new Promise((resolve) => setTimeout(resolve, 25))
    last = await storedFinding(app, nodeId)
  }
  assert.equal(last, expected, `the finding on ${nodeId} in ${app}`)
}

// Each re-check waits 150 ms before it runs, so a graph written by a pending
// one changes within this span.
const QUIET_MS = 1000

function stamps(apps: readonly string[]): number[] {
  return apps.map((app) => registry.resolveGraph(app)?.graph.updatedAt.getTime() ?? Number.NaN)
}

/** Waits until none of `apps` has been written for QUIET_MS, failing after `ms`. */
async function quiet(apps: readonly string[], ms = 10000): Promise<void> {
  const until = Date.now() + ms
  let before = stamps(apps)
  while (Date.now() < until) {
    // biome-ignore lint/plugin/noTestFixedTime: samples the stamps every QUIET_MS until they stop moving, within a deadline
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS))
    const now = stamps(apps)
    if (now.every((stamp, i) => stamp === before[i])) {
      return
    }
    before = now
  }
  assert.fail(`${apps.join(', ')} kept being written for ${ms} ms`)
}

test('a write on one graph raises and clears the finding stored on another graph nobody writes', async () => {
  const one = await emptyGraph('twins-one')
  const two = await emptyGraph('twins-two')
  const kept = await createTwin(one.app, 'lamp')
  assert.equal(await storedFinding(one.app, kept), null, 'CONTROL: alone, it has no twin')

  // Added on graph two: its own check sees graph one, and graph one is checked again.
  const twin = await createTwin(two.app, 'lamp')
  assert.equal(await storedFinding(two.app, twin), one.app, 'the new node sees the twin on graph one')
  await settles(one.app, kept, two.app)

  // Changed on graph two.
  await call(two.app, 'updateNodes', { updates: [{ nodeId: twin, data: { label: 'desk' } }] })
  await settles(one.app, kept, null)
  await call(two.app, 'updateNodes', { updates: [{ nodeId: twin, data: { label: 'lamp' } }] })
  await settles(one.app, kept, two.app)

  // Rewired on graph two in one write, as the canvas moves an edge's end: the
  // edge into a plain node moves from another plain node to the twin and back.
  // The node it ends at keeps the same input unresolved, so only an edge
  // changes, no node's data.
  const [from, to] = [await createPlain(two.app), await createPlain(two.app)]
  await call(two.app, 'connectNodes', { edges: [{ source: `${from}/out`, target: `${to}/in` }] })
  await quiet([one.app, two.app])
  const nodesOfTwo = () => JSON.stringify(registry.resolveGraph(two.app)?.graph.graph.nodes)
  const unwired = nodesOfTwo()
  await rewire(two.app, from, twin)
  await settles(one.app, kept, `${two.app} (wired)`)
  assert.equal(nodesOfTwo(), unwired, 'CONTROL: no node on graph two changed')
  await rewire(two.app, twin, from)
  await settles(one.app, kept, two.app)

  // Removed from graph two.
  await call(two.app, 'deleteNodes', { nodeIds: [twin] })
  await settles(one.app, kept, null)

  // Deleted with its graph.
  const three = await emptyGraph('twins-three')
  await createTwin(three.app, 'lamp')
  await settles(one.app, kept, three.app)
  // Graph one's new finding checks graph three again; a deletion while that
  // write is in flight leaves the write nowhere to be recorded.
  await quiet([one.app, three.app])
  assert.ok(await registry.remove(three.slug), 'the third space is removed')
  await settles(one.app, kept, null)
})

test('a finding naming another graph follows its new address: graph renamed, space renamed, graph transferred', async () => {
  const one = await emptyGraph('twins-moved-one')
  const two = await emptyGraph('twins-moved-two')
  const kept = await createTwin(one.app, 'bell')
  await createTwin(two.app, 'bell')
  await settles(one.app, kept, two.app)
  await quiet([one.app, two.app])
  const moving = registry.resolveGraph(two.app)?.graph
  assert.ok(moving, 'graph two resolves')
  const addressOfTwo = () => {
    const ref = registry.graphById(moving.id)
    assert.ok(ref, 'graph two is still a graph of the instance')
    return registry.addressOf(ref)
  }

  await renameSpaceAppImpl(moving.instanceId, `Bell graph ${suffix}`)
  assert.notEqual(addressOfTwo(), two.app, 'CONTROL: the graph took a new address')
  await settles(one.app, kept, addressOfTwo())

  const renamed = await renameSpaceImpl({ slug: two.slug, name: `twins-moved-renamed-${suffix}` })
  assert.ok(renamed.ok, 'the space is renamed')
  await settles(one.app, kept, addressOfTwo())

  const target = await registry.create(`twins-moved-target-${suffix}`, `twins-moved-target-${suffix}`, {
    nodes: [],
    edges: [],
  })
  await transferSpaceAppImpl(moving.instanceId, target.slug)
  assert.ok(addressOfTwo().startsWith(`${target.slug}.`), 'CONTROL: the graph is in the target space')
  await settles(one.app, kept, addressOfTwo())
})

test('findings over several graphs settle, and the graphs then stop being written', async () => {
  const one = await emptyGraph('twins-settle-one')
  const two = await emptyGraph('twins-settle-two')
  const three = await emptyGraph('twins-settle-three')
  // A graph is also checked once just after its document loads; each waits that
  // out, so the earlier graphs learn of the later twins only by being checked again.
  const a = await createTwin(one.app, 'fan')
  await quiet([one.app])
  const b = await createTwin(two.app, 'fan')
  await quiet([one.app, two.app])
  const c = await createTwin(three.app, 'fan')
  await settles(one.app, a, [two.app, three.app].sort().join(', '))
  await settles(two.app, b, [one.app, three.app].sort().join(', '))
  await settles(three.app, c, [one.app, two.app].sort().join(', '))

  // Settling ends in a span with no write; a loop between the graphs would never have one.
  await quiet([one.app, two.app, three.app])
})
