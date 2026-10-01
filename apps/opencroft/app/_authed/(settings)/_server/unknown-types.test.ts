// The unknown-types scan and replace, against the real space registry and
// app table. Fixture extensions and app data are written into a scratch data
// dir, which the extension root follows, so nothing installed on the machine
// running this joins the population. The test
// database is shared with other suites, so assertions look for this run's own
// types rather than at the whole result, and every test that writes uses
// spaces and types of its own.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { db, spaceApp } from '@opencroft/db'
import { eq } from 'drizzle-orm'

import { appInstanceDataDir } from '@/app/_authed/(apps)/_server/instance-paths'
import { qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import {
  planTypeReplacement,
  type RegistryListing,
  replaceType,
  scanUnknownTypes,
} from '@/app/_authed/(settings)/_server/unknown-types'
import { loadSpaceGraphImpl } from '@/app/_authed/(space)/_server/actions-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

const suffix = crypto.randomUUID().slice(0, 8)
const root = mkdtempSync(join(tmpdir(), 'unknown-types-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = join(root, 'data')
after(() => {
  rmSync(root, { recursive: true, force: true })
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
})

// One installed extension: a node type with one input and one output, an App,
// and a handle on its node whose type nothing declares. Declared bare, as a
// manifest declares; every type the page sees is qualified with the id.
const EXTENSION = `widgets-${suffix}`
const EXTENSION_ID = `local.${EXTENSION}`
const SIGNAL = qualifyType(EXTENSION_ID, 'signal')
const KNOWN_NODE = qualifyType(EXTENSION_ID, 'gauge')
const KNOWN_APP = qualifyType(EXTENSION_ID, 'board')
const GHOST_HANDLE = qualifyType(EXTENSION_ID, 'ghost')
mkdirSync(join(root, 'data', 'extensions', EXTENSION_ID), { recursive: true })
writeFileSync(
  join(root, 'data', 'extensions', EXTENSION_ID, 'extension.json'),
  JSON.stringify({
    id: EXTENSION_ID,
    name: 'Widgets',
    version: '0.0.0',
    handleTypes: [{ id: 'signal', label: 'Signal', color: 'red' }],
    nodes: [
      {
        type: 'gauge',
        name: 'Gauge',
        handles: [
          { id: 'in', handleType: 'signal', role: 'target' },
          { id: 'out', handleType: 'signal', role: 'source' },
          { id: 'haunted', handleType: 'ghost', role: 'source', label: 'Haunted' },
        ],
      },
    ],
    provides: { apps: [{ type: 'board', title: 'Board' }] },
  }),
)

const spaces = getSpacesRegistry()
await spaces.ensureLoaded()

function node(id: string, type: string, name?: string) {
  return { id, type, position: { x: 0, y: 0 }, data: name ? { name } : {} }
}

let spaceCount = 0
async function space(graph: GraphData) {
  spaceCount += 1
  const created = await spaces.create(`types-${spaceCount}-${suffix}`, `types-${spaceCount}-${suffix}`, graph)
  const address = `${created.slug}.${created.defaultGraphSlug}`
  const graphName = created.graphs.get(created.defaultGraphSlug)?.name
  return { space: created, address, location: `${created.name} / ${graphName}` }
}

async function nodesOf(address: string): Promise<Array<[string, string]>> {
  const loaded = await loadSpaceGraphImpl(address)
  assert.ok(loaded, `${address} loads`)
  return (loaded.graph.nodes as Array<{ id: string; type: string }>).map((n) => [n.id, n.type])
}

async function edgeIdsOf(address: string): Promise<string[]> {
  const loaded = await loadSpaceGraphImpl(address)
  assert.ok(loaded, `${address} loads`)
  return (loaded.graph.edges as Array<{ id: string }>).map((e) => e.id)
}

async function appRow(type: string, name: string) {
  const [row] = await db
    .insert(spaceApp)
    .values({
      spaceId: scanned.space.id,
      type,
      name,
      slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix}`,
    })
    .returning()
  return row
}

const noRegistries = async (): Promise<RegistryListing> => ({ extensions: [], unreachable: [] })

// Read-only population for the scan and plan tests: two uses of an unknown
// node type wired to a known one — bare, as stored before types named their
// extension — a node of a qualified unknown type, and an app instance of an
// App no extension provides.
const GONE_NODE = `dial-${suffix}`
const QUALIFIED_NODE = `acme.meters-${suffix}.dial`
const GONE_APP = `local.gone-${suffix}.board`
const scanned = await space({
  nodes: [
    node('dial-named', GONE_NODE, 'Left dial'),
    node('dial-plain', GONE_NODE),
    node('gauge', KNOWN_NODE),
    node('qualified', QUALIFIED_NODE),
  ],
  edges: [
    // The gauge declares both `out` and `in`: not stale after a replace with it.
    { id: 'e-declared', source: 'dial-named', sourceHandle: 'out', target: 'gauge', targetHandle: 'in' },
    // The gauge declares no `needle` output: stale after a replace with it.
    { id: 'e-stale', source: 'dial-plain', sourceHandle: 'needle', target: 'gauge', targetHandle: 'in' },
  ],
})
await appRow(GONE_APP, 'Old board')

test('an unknown node type is listed once, with every node using it', async () => {
  const scan = await scanUnknownTypes(noRegistries)
  const entries = scan.unknown.filter((u) => u.kind === 'node' && u.type === GONE_NODE)
  assert.equal(entries.length, 1)
  assert.deepEqual(
    entries[0].usages.map((u) => u.label),
    ['Left dial', 'dial-plain'],
  )
  assert.deepEqual(
    [...new Set(entries[0].usages.map((u) => u.href))],
    [`/space/${scanned.space.slug}/app/${scanned.space.defaultGraphSlug}`],
  )
})

test('types an installed extension provides are not listed, and are offered as replacements', async () => {
  const scan = await scanUnknownTypes(noRegistries)
  const listed = new Set(scan.unknown.map((u) => `${u.kind}:${u.type}`))
  assert.ok(!listed.has(`node:${KNOWN_NODE}`))
  assert.ok(!listed.has(`handle:${SIGNAL}`))
  assert.ok(!listed.has(`app:${KNOWN_APP}`))
  assert.ok(scan.replacements.some((r) => r.kind === 'node' && r.type === KNOWN_NODE && r.label === 'Gauge'))
  assert.ok(scan.replacements.some((r) => r.kind === 'app' && r.type === KNOWN_APP && r.label === 'Board'))
})

test('an app instance whose App no extension provides is listed under its type', async () => {
  const scan = await scanUnknownTypes(noRegistries)
  const entry = scan.unknown.find((u) => u.kind === 'app' && u.type === GONE_APP)
  assert.deepEqual(entry?.usages, [
    { label: 'Old board', location: scanned.space.name, href: `/space/${scanned.space.slug}/app/old-board-${suffix}` },
  ])
})

test('a handle type a manifest uses but no extension declares is listed, naming its declarer', async () => {
  const scan = await scanUnknownTypes(noRegistries)
  const entry = scan.unknown.find((u) => u.kind === 'handle' && u.type === GHOST_HANDLE)
  assert.deepEqual(entry?.usages, [{ label: 'Gauge: Haunted', location: 'Widgets' }])
})

test('a qualified type is offered for install from the registry that lists its extension', async () => {
  const scan = await scanUnknownTypes(async () => ({
    extensions: [{ id: `acme.meters-${suffix}`, registryName: 'Acme' }],
    unreachable: [],
  }))
  const entry = scan.unknown.find((u) => u.type === QUALIFIED_NODE)
  assert.deepEqual(entry?.install, { extensionId: `acme.meters-${suffix}`, registryName: 'Acme' })
  assert.deepEqual(scan.unreachableRegistries, [])
  assert.equal(scan.unknown.find((u) => u.type === GONE_NODE)?.install, undefined, 'a bare type names no extension')
})

test('a type of an installed extension is not offered for install, even where a registry lists it', async () => {
  const scan = await scanUnknownTypes(async () => ({
    extensions: [{ id: EXTENSION_ID, registryName: 'Acme' }],
    unreachable: [],
  }))
  const entry = scan.unknown.find((u) => u.kind === 'handle' && u.type === GHOST_HANDLE)
  assert.ok(entry, 'the handle type its installed extension does not declare is listed')
  assert.equal(entry.install, undefined)
})

test('a registry that could not be read is named, and nothing is offered from it', async () => {
  const scan = await scanUnknownTypes(async () => ({ extensions: [], unreachable: ['Acme'] }))
  assert.deepEqual(scan.unreachableRegistries, ['Acme'])
  assert.equal(scan.unknown.find((u) => u.type === QUALIFIED_NODE)?.install, undefined)
})

test('the plan counts every use and names the edges the replacement does not declare', async () => {
  const plan = await planTypeReplacement({ kind: 'node', from: GONE_NODE, to: KNOWN_NODE })
  assert.deepEqual(plan, {
    count: 2,
    staleEdges: [{ location: scanned.location, node: 'dial-plain', handle: 'needle' }],
  })
})

test('a replace refuses a type an extension provides, and a replacement none provides', async () => {
  const refused = `refused-${suffix}`
  const fixture = await space({ nodes: [node('n', refused)], edges: [] })
  await assert.rejects(replaceType({ kind: 'node', from: KNOWN_NODE, to: KNOWN_NODE }), /only an unknown node type/)
  await assert.rejects(replaceType({ kind: 'node', from: refused, to: `missing-${suffix}` }), /No installed extension/)
  await assert.rejects(replaceType({ kind: 'app', from: GONE_APP, to: KNOWN_NODE }), /No installed extension/)
  assert.deepEqual(await nodesOf(fixture.address), [['n', refused]], 'nothing was rewritten')
})

test('a node replace rewrites every use in every graph and keeps every edge', async () => {
  const from = `needle-${suffix}`
  const first = await space({
    nodes: [node('one', from), node('gauge', KNOWN_NODE)],
    edges: [{ id: 'wire', source: 'one', sourceHandle: 'nowhere', target: 'gauge', targetHandle: 'in' }],
  })
  const second = await space({ nodes: [node('two', from)], edges: [] })

  assert.deepEqual(await replaceType({ kind: 'node', from, to: KNOWN_NODE }), { replaced: 2, failures: [] })

  assert.deepEqual(await nodesOf(first.address), [
    ['one', KNOWN_NODE],
    ['gauge', KNOWN_NODE],
  ])
  assert.deepEqual(await edgeIdsOf(first.address), ['wire'], 'the stale edge is kept')
  assert.deepEqual(await nodesOf(second.address), [['two', KNOWN_NODE]])
  const scan = await scanUnknownTypes(noRegistries)
  assert.ok(!scan.unknown.some((u) => u.type === from), 'the type is no longer unknown')
})

test('an app replace rebinds the instance, keeping its row and moving its data', async () => {
  const goneExtension = `local.retired-${suffix}`
  const row = await appRow(qualifyType(goneExtension, 'board'), 'Retired board')
  const oldDataDir = appInstanceDataDir(goneExtension, row.id)
  mkdirSync(oldDataDir, { recursive: true })
  writeFileSync(join(oldDataDir, 'notes.txt'), 'kept')

  const result = await replaceType({ kind: 'app', from: row.type, to: KNOWN_APP })

  assert.deepEqual(result, { replaced: 1, failures: [] })
  const after = await db.query.spaceApp.findFirst({ where: eq(spaceApp.id, row.id) })
  assert.deepEqual(after && [after.type, after.name, after.slug], [KNOWN_APP, 'Retired board', row.slug])
  assert.equal(readFileSync(join(appInstanceDataDir(EXTENSION_ID, row.id), 'notes.txt'), 'utf-8'), 'kept')
  assert.equal(existsSync(oldDataDir), false, 'the data moved rather than being copied')
})
