// What a client bundle declares -- its provider points, whether it has
// settings pages, its node types' default data -- is read off the built bundle
// itself, and the browser imports a bundle only where that is shown. A wrong answer in one direction
// hides a panel, so these build real bundles and pin both halves: what is
// read, and that every doubt reads as "not known".
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { NUMBER_TYPE, STRING_TYPE } from '@opencroft/core/values'

import { buildExtension, buildExtensionAt } from './compiler'
import { builtinSourceRoot, PROVIDED_POINTS_FILE } from './paths'
import { bundleDeclares, nodeTypeDefaults, probeBundleDeclares } from './provided-points'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-provided-points-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = root

after(async () => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  await fs.rm(root, { recursive: true, force: true })
})

const NOT_KNOWN = { providedPoints: null, hasSettingsPages: null }

let seq = 0

/** A client-only extension `local.points-<n>` whose client entry is `source`. */
async function makeExtension(source: string): Promise<{ id: string; dir: string; manifest: object }> {
  seq += 1
  const id = `local.points-${seq}`
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), source)
  const manifest = { id, name: id, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  return { id, dir, manifest }
}

async function build(id: string, manifest: object): Promise<void> {
  const result = await buildExtension(id, manifest as Parameters<typeof buildExtension>[1])
  assert.ok(result.success, JSON.stringify(result.errors))
}

async function providedPoints(id: string): Promise<string[] | null> {
  return (await bundleDeclares(id)).providedPoints
}

/** Waits, with a generous deadline, for a background reading to be recorded. */
async function readAgain(id: string) {
  const deadline = Date.now() + 20_000
  let declares = await bundleDeclares(id)
  while (declares.providedPoints === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    declares = await bundleDeclares(id)
  }
  return declares
}

const PANEL_SOURCE = `
import { defineExtension, React } from '@ext/host'

const Context = React.createContext(null)
class Legacy extends React.Component {}
const Panel = () => <Context.Provider value={null}><Legacy /></Context.Provider>

export default defineExtension({
  manifest: { name: 'panels' },
  provides: {
    'right-sidebar-panels': [{ id: 'outline', label: 'Outline', component: Panel }],
    markdownResolvers: [{ id: 'acme.ticket', pattern: 'T-\\\\d+', resolve: async () => ({}) }],
  },
})
`

const SETTINGS_SOURCE = `
import { defineExtension } from '@ext/host'

export default defineExtension({
  manifest: { name: 'settings' },
  settings: [{ id: 'general', label: 'General', component: () => null }],
})
`

test('a build records the points its bundle registers, and that it has no settings pages', async () => {
  const { id, manifest } = await makeExtension(PANEL_SOURCE)
  await build(id, manifest)

  assert.deepEqual(await bundleDeclares(id), {
    providedPoints: ['markdownResolvers', 'right-sidebar-panels'],
    hasSettingsPages: false,
  })
})

test('a build records that its bundle declares settings pages', async () => {
  const { id, manifest } = await makeExtension(SETTINGS_SOURCE)
  await build(id, manifest)

  assert.deepEqual(await bundleDeclares(id), { providedPoints: [], hasSettingsPages: true })
})

test('a recompile replaces the answer with the new bundle’s', async () => {
  const { id, dir, manifest } = await makeExtension(PANEL_SOURCE)
  await build(id, manifest)
  await fs.writeFile(
    path.join(dir, 'src', 'client.tsx'),
    "export default { provides: { apps: [{ type: 'notes' }] }, settings: [{ id: 'general' }] }\n",
  )
  await build(id, manifest)

  assert.deepEqual(await bundleDeclares(id), { providedPoints: ['apps'], hasSettingsPages: true })
})

test('a point declared with no entries is still a point', async () => {
  // Its entries may depend on what the browser has; the key does not.
  const { id, manifest } = await makeExtension('export default { provides: { apps: [] } }\n')
  await build(id, manifest)

  assert.deepEqual(await providedPoints(id), ['apps'])
})

test('module-level use of browser globals does not stop the reading', async () => {
  const { id, manifest } = await makeExtension(`
const probe = document.createElement('i')
probe.innerHTML = '&amp;'
window.addEventListener('resize', () => {})
export default { provides: { apps: [{ type: 'notes', label: localStorage.getItem('label') }] } }
`)
  await build(id, manifest)

  assert.deepEqual(await providedPoints(id), ['apps'])
})

test('a bundle that throws while it loads is not known', async () => {
  const { id, manifest } = await makeExtension(`
export default { provides: { apps: [] } }
throw new Error('fails at load')
`)
  await build(id, manifest)

  assert.deepEqual(await bundleDeclares(id), NOT_KNOWN)
})

test('a provides that spreads a host value is not known', async () => {
  // A stub has no keys to spread, while the browser's value might.
  const { id, manifest } = await makeExtension(`
import { React } from '@ext/host'
export default { provides: { apps: [], ...React.Children } }
`)
  await build(id, manifest)

  assert.deepEqual(await bundleDeclares(id), NOT_KNOWN)
})

test('a provides that is not a plain object of arrays is not known', async () => {
  const { id, manifest } = await makeExtension("export default { provides: { apps: 'notes' } }\n")
  await build(id, manifest)

  assert.deepEqual(await bundleDeclares(id), NOT_KNOWN)
})

test('a settings that is not an array is not known', async () => {
  const { id, manifest } = await makeExtension("export default { provides: { apps: [] }, settings: 'general' }\n")
  await build(id, manifest)

  assert.deepEqual(await bundleDeclares(id), NOT_KNOWN)
})

test('a record read from another build of the bundle is not used, and is read again', async () => {
  const { id, dir, manifest } = await makeExtension(PANEL_SOURCE)
  await build(id, manifest)
  // The served bundle is now another build than the one the record names.
  const bundle = path.join(dir, 'dist', 'client.js')
  const later = new Date(Date.now() + 60 * 60 * 1000)
  await fs.utimes(bundle, later, later)

  assert.deepEqual(await bundleDeclares(id), NOT_KNOWN, 'a stale record must not answer for the served bundle')

  assert.deepEqual(await readAgain(id), {
    providedPoints: ['markdownResolvers', 'right-sidebar-panels'],
    hasSettingsPages: false,
  })
})

test('a record that lacks a field is not used, and is read again', async () => {
  const { id, dir, manifest } = await makeExtension(SETTINGS_SOURCE)
  await build(id, manifest)
  // The served bundle's own record, without the settings answer.
  const record = path.join(dir, 'dist', PROVIDED_POINTS_FILE)
  const { hasSettingsPages: _dropped, ...partial } = JSON.parse(await fs.readFile(record, 'utf-8'))
  await fs.writeFile(record, JSON.stringify(partial))

  assert.deepEqual(await bundleDeclares(id), NOT_KNOWN, 'a partial record must not answer for the bundle')

  assert.deepEqual(await readAgain(id), { providedPoints: [], hasSettingsPages: true })
})

// ── node defaults ────────────────────────────────────────────────────

const NODES_SOURCE = `
import { defineExtension, React } from '@ext/host'

const Gauge = () => null

export default defineExtension({
  manifest: { name: 'nodes' },
  nodes: [
    { type: 'gauge', name: 'Gauge', component: Gauge, defaultData: { title: 'Gauge', ranges: [{ from: 0, to: 10 }], unit: null } },
    { typeId: 'dial', name: 'Dial', component: Gauge, defaultData: { on: true } },
    { type: 'plain', name: 'Plain', component: Gauge },
    { type: 'hosted', name: 'Hosted', component: Gauge, defaultData: { kind: React.Children } },
    { type: 'dated', name: 'Dated', component: Gauge, defaultData: { at: new Date(0) } },
  ],
})
`

test('a build records each node type’s default data, which a node created on the server starts with', async () => {
  const { id, manifest } = await makeExtension(NODES_SOURCE)
  await build(id, manifest)

  assert.deepEqual(await nodeTypeDefaults(`${id}.gauge`), {
    title: 'Gauge',
    ranges: [{ from: 0, to: 10 }],
    unit: null,
  })
  assert.deepEqual(await nodeTypeDefaults(`${id}.dial`), { on: true }, 'a type declared by the deprecated typeId')
  assert.equal(await nodeTypeDefaults(`${id}.plain`), undefined, 'a type that declares none')
  assert.equal(await nodeTypeDefaults(`${id}.missing`), undefined, 'a type the bundle does not declare')
})

test('default data that is not plain data is not applied, and the rest of the bundle is still read', async () => {
  const { id, manifest } = await makeExtension(NODES_SOURCE)
  await build(id, manifest)

  assert.equal(await nodeTypeDefaults(`${id}.hosted`), undefined, 'a host value')
  assert.equal(await nodeTypeDefaults(`${id}.dated`), undefined, 'a class instance')
  assert.deepEqual(await bundleDeclares(id), { providedPoints: [], hasSettingsPages: false })
})

test('a creation waits for a bundle with no record of its defaults to be read', async () => {
  const { id, dir, manifest } = await makeExtension(NODES_SOURCE)
  await build(id, manifest)
  // The served bundle's own record, as one written before defaults were read.
  const record = path.join(dir, 'dist', PROVIDED_POINTS_FILE)
  const { nodeDefaults: _dropped, ...partial } = JSON.parse(await fs.readFile(record, 'utf-8'))
  await fs.writeFile(record, JSON.stringify(partial))

  assert.deepEqual(await nodeTypeDefaults(`${id}.dial`), { on: true })
})

test('parallel creations and a listing share one reading of a bundle with no record', async () => {
  const { id, dir } = await makeExtension(NODES_SOURCE)
  // A served bundle that logs each time it is evaluated, with no record yet.
  const dist = path.join(dir, 'dist')
  await fs.mkdir(dist, { recursive: true })
  await fs.writeFile(
    path.join(dist, 'client.js'),
    `import { appendFileSync } from 'node:fs'
appendFileSync(new URL('./readings.log', import.meta.url), 'read\\n')
export default { nodes: [{ type: 'dial', defaultData: { on: true } }] }
`,
  )

  const [listed, ...created] = await Promise.all([
    bundleDeclares(id),
    ...Array.from({ length: 4 }, () => nodeTypeDefaults(`${id}.dial`)),
  ])

  assert.deepEqual(listed, NOT_KNOWN, 'a listing does not wait for the reading')
  assert.deepEqual(created, Array(4).fill({ on: true }))
  assert.equal(await fs.readFile(path.join(dist, 'readings.log'), 'utf-8'), 'read\n', 'the bundle was evaluated once')
})

// A host module's exports are stubs while a bundle is read, so a default built
// from one (a type constant from `@opencroft/client/values`) is not plain data.
test('every node type of the builtin core bundle declares defaults the server reads', async () => {
  const sourceDir = path.join(builtinSourceRoot(), 'core')
  const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, 'extension.json'), 'utf-8'))
  const distDir = path.join(root, 'builtin-core-dist')
  const result = await buildExtensionAt({ extensionId: 'builtin.core', sourceDir, distDir }, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))

  const { defaultsNotRead, nodeDefaults, reason } = await probeBundleDeclares(path.join(distDir, 'client.js'))

  assert.equal(reason, undefined)
  assert.equal(defaultsNotRead, undefined)
  assert.deepEqual(nodeDefaults?.value, { valueType: STRING_TYPE, value: '' })
  assert.deepEqual(nodeDefaults?.convert, { valueType: NUMBER_TYPE })
})

test('a type of an extension with no built bundle has no defaults', async () => {
  const { id } = await makeExtension(NODES_SOURCE)

  assert.equal(await nodeTypeDefaults(`${id}.gauge`), undefined)
  assert.equal(await nodeTypeDefaults('not-a-type'), undefined)
})

test('a bundle that is not built is not known', async () => {
  const { id } = await makeExtension(PANEL_SOURCE)

  assert.deepEqual(await bundleDeclares(id), NOT_KNOWN)
})

test('a bundle that never finishes loading is ended and not known', async () => {
  const dir = await fs.mkdtemp(path.join(root, 'loop-'))
  const bundle = path.join(dir, 'client.mjs')
  await fs.writeFile(bundle, 'while (true) {}\nexport default { provides: { apps: [] } }\n')

  const answer = await probeBundleDeclares(bundle, 300)

  assert.equal(answer.providedPoints, null)
  assert.equal(answer.hasSettingsPages, null)
  assert.match(answer.reason ?? '', /did not finish loading/)
})

test('the network is refused while a bundle is read', async () => {
  const dir = await fs.mkdtemp(path.join(root, 'net-'))
  const bundle = path.join(dir, 'client.mjs')
  await fs.writeFile(bundle, "await fetch('http://127.0.0.1:9/')\nexport default { provides: { apps: [] } }\n")

  const answer = await probeBundleDeclares(bundle)

  assert.equal(answer.providedPoints, null)
  assert.match(answer.reason ?? '', /fetch is not available/)
})

test('a bundle being read does not see the server’s environment', async () => {
  assert.ok(process.env.OPENCROFT_DATA_DIR, 'the server environment has a variable to hide')
  const dir = await fs.mkdtemp(path.join(root, 'env-'))
  const bundle = path.join(dir, 'client.mjs')
  await fs.writeFile(
    bundle,
    "export default { provides: { [process.env.OPENCROFT_DATA_DIR ? 'saw-env' : 'apps']: [] } }\n",
  )

  const answer = await probeBundleDeclares(bundle)

  assert.deepEqual(answer.providedPoints, ['apps'])
})
