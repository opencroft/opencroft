// A node type's declared credential properties (`nodeCredentialProperties`),
// reached the way agents reach them: the graph's read and write actions
// through `app_call`, on a real graph, with a fixture extension whose server
// module declares them.
//
// Pinned: getNodes, findNodes, createNodes and updateNodes show a typed value
// under a declared property as `[redacted]`; a `secret:<NAME>` reference under
// it is returned as it is; and the declaration covers its own type only.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// tools.ts sits on an import cycle with the agent client; a static import from
// here would enter it, so the registry is loaded on first use instead.
const { handleToolCall } = await import('@/app/_authed/(mcp)/_server/tools')

const suffix = crypto.randomUUID().slice(0, 8)

// A scratch data dir, so no extension installed on the machine joins in.
const root = mkdtempSync(join(tmpdir(), 'graph-credential-properties-'))
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

// `proxy` declares `basicAuth` a credential; `plain` has the same property and declares nothing.
const FOLDER = `local.creds-${suffix}`
mkdirSync(join(root, 'extensions', FOLDER, 'server'), { recursive: true })
writeFileSync(
  join(root, 'extensions', FOLDER, 'extension.json'),
  JSON.stringify({
    id: FOLDER,
    name: `Creds ${suffix}`,
    version: '0.0.0',
    nodes: [
      { type: 'proxy', name: 'Proxy' },
      { type: 'plain', name: 'Plain' },
    ],
  }),
)
writeFileSync(
  join(root, 'extensions', FOLDER, 'server', 'index.ts'),
  `export const nodeCredentialProperties = { proxy: ['basicAuth'] }\n`,
)
const PROXY = qualifyType(FOLDER, 'proxy')
const PLAIN = qualifyType(FOLDER, 'plain')

// A legacy hand-made htpasswd line: a user and a hash, under a name no rule reads as a credential.
const HTPASSWD = 'alice:$apr1$placeholder$hash'
const TYPED = `typed-${suffix}`
const REFERENCED = `referenced-${suffix}`
const UNDECLARED = `undeclared-${suffix}`

const registry = getSpacesRegistry()
await registry.ensureLoaded()
const space = await registry.create(`credential-properties-${suffix}`, `credential-properties-${suffix}`, {
  nodes: [
    { id: TYPED, type: PROXY, position: { x: 0, y: 0 }, data: { basicAuth: HTPASSWD, label: 'edge' } },
    { id: REFERENCED, type: PROXY, position: { x: 0, y: 200 }, data: { basicAuth: 'secret:PROXY_AUTH' } },
    { id: UNDECLARED, type: PLAIN, position: { x: 0, y: 400 }, data: { basicAuth: HTPASSWD } },
  ],
  edges: [],
})
const [graph] = registry.graphsOf(space.slug)
assert.ok(graph, 'the space has its default graph')
const address = `${space.slug}.${graph.slug}`

async function call(action: string, params: Record<string, unknown>): Promise<unknown> {
  const result = await handleToolCall('app_call', { app: address, action, params }, { internal: true })
  const text = (result.content as { text: string }[])[0]?.text ?? ''
  assert.notEqual(result.isError, true, text)
  return JSON.parse(text)
}

type ReadNode = { id: string; data: Record<string, unknown> }

test('getNodes hides a typed value under a declared property, and keeps a secret reference', async () => {
  const { found } = (await call('getNodes', { nodeIds: [TYPED, REFERENCED] })) as { found: ReadNode[] }
  const byId = new Map(found.map((node) => [node.id, node.data]))
  assert.equal(byId.get(TYPED)?.basicAuth, '[redacted]')
  assert.equal(byId.get(TYPED)?.label, 'edge')
  assert.equal(byId.get(REFERENCED)?.basicAuth, 'secret:PROXY_AUTH')
})

test('a type that declares nothing returns the same property as it is', async () => {
  const { found } = (await call('getNodes', { nodeIds: [UNDECLARED] })) as { found: ReadNode[] }
  assert.equal(found[0]?.data.basicAuth, HTPASSWD)
})

test('findNodes cannot find a declared credential by its value', async () => {
  const matched = (await call('findNodes', { patterns: ['*$apr1$*'] })) as { id: string }[]
  assert.deepEqual(
    matched.map((m) => m.id),
    [UNDECLARED],
  )
})

test('createNodes and updateNodes answer with the declared credential hidden', async () => {
  const created = (await call('createNodes', { nodes: [{ type: PROXY, data: { basicAuth: HTPASSWD } }] })) as ReadNode[]
  assert.equal(created[0]?.data.basicAuth, '[redacted]')
  const updated = (await call('updateNodes', {
    updates: [{ nodeId: TYPED, data: { label: 'renamed' } }],
  })) as ReadNode[]
  assert.equal(updated[0]?.data.basicAuth, '[redacted]')
  assert.equal(updated[0]?.data.label, 'renamed')
})
