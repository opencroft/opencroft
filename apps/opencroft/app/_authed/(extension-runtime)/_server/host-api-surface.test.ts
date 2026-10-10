// What an extension receives from the host used to be two enumerations that
// had to agree: the object the host exports, and the generated shim the
// extension actually imports. The shim is now built from the object, so the
// two cannot disagree — and the tests below are what holds that, by importing
// the same objects the browser is handed and demanding every one of their
// names back out of a real build.
//
// This exercises the real build, so the wiring is read out of the emitted
// bundle rather than assumed from the source of the shim.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

// Statically, and deliberately -- do not make this a dynamic import inside a
// test. The compiler loads this module on demand to read the API objects, and
// its consumers include the extension dev loop, which runs it under bare `tsx`
// rather than in the app server. Loading the app's whole client component tree
// in that runtime is where that would break, and nothing else checks it: a
// production build exercises a different bundler and a different graph. The
// test runner is `tsx` too, so this import failing is how that would be found
// -- which makes it load-bearing for a runtime rather than for the assertions
// below, and invisible as such to anyone reading only what the tests assert.
import {
  extensionClientModules,
  extensionHostApi,
  extensionUiApi,
} from '@/app/_authed/(extension-runtime)/_client/host'
import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'
import { buildExtension } from './compiler'
import { SERVER_MODULES } from './extension-api-modules'
import { extensionScopedExports } from './host-shims'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-host-api-'))
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

async function buildProbe(slug: string, clientSource: string): Promise<string> {
  const id = `local.${slug}`
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), clientSource)
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  const manifest: ExtensionManifest = { id, name: slug, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
  return await fs.readFile(path.join(dir, 'dist', 'client.js'), 'utf-8')
}

test('an extension can read, set and clear a URL parameter through the host API', async () => {
  const bundle = await buildProbe(
    'url-param',
    [
      "import { useUrlParam } from '@ext/host'",
      '',
      'export function Probe() {',
      "  const view = useUrlParam('view')",
      "  return { current: view.value, open: () => view.set('graph'), close: () => view.remove() }",
      '}',
      '',
    ].join('\n'),
  )

  // Forwarded off the host object rather than bundled from somewhere else or
  // quietly resolved to nothing — reading the name off the host is the shim's
  // whole job. Asserted as the two facts that make it true, rather than as the
  // shape of the emitted forward: minification renames every local, so a
  // property name read off the host is the one thing that survives, and it is
  // there only because the shim went looking for it.
  assert.match(bundle, /globalThis\.__extHost/)
  assert.match(bundle, /\buseUrlParam\b/)
})

// Import every name at once rather than one build per name: the failure being
// guarded against is a name missing from the shim, and esbuild reports every
// such name in one build, so a single probe names all of them at once.
async function buildImportingEveryName(slug: string, specifier: string, names: string[]): Promise<void> {
  const list = names.join(', ')
  await buildProbe(
    slug,
    [`import { ${list} } from '${specifier}'`, '', `export const probe = [${list}]`, ''].join('\n'),
  )
}

test('every capability on the host object is importable by name from @ext/host', async () => {
  // Covers the whole object rather than a checked-in list of names, so a
  // capability added to the host is covered by this test the moment it exists
  // — which is the failure this suite was written for: three names were added
  // to the host object, missed in a hand-kept export list, and every extension
  // importing them the idiomatic way failed to build.
  await buildImportingEveryName('host-surface', '@ext/host', Object.keys(extensionHostApi))
})

test('every component on the ui object is importable by name from @ext/ui', async () => {
  await buildImportingEveryName('ui-surface', '@ext/ui', Object.keys(extensionUiApi))
})

// What each module declares is held against these objects by
// host-api-declarations.test.ts; this half checks the shims serve it.
function moduleNames(module: keyof typeof extensionClientModules): string[] {
  return [
    ...Object.keys(extensionClientModules[module]),
    ...extensionScopedExports('acme.probe')
      .filter((entry) => entry.module === module)
      .map((entry) => entry.name),
  ]
}

test('every client module serves its names, and the package root serves all of them', async () => {
  const modules = Object.keys(extensionClientModules) as (keyof typeof extensionClientModules)[]
  assert.ok(modules.length > 5, `expected the client modules to be read; found ${modules.length}`)
  for (const module of modules) {
    const names = moduleNames(module)
    // A module whose only names are bound by the shim (storage) is still
    // checked: an empty list would build an empty import and prove nothing.
    assert.ok(names.length > 0, `@opencroft/client/${module} serves no name`)
    await buildImportingEveryName(`client-${module}`, `@opencroft/client/${module}`, names)
  }
  await buildImportingEveryName('client-root', '@opencroft/client', [...modules.flatMap(moduleNames), 'legacy'])
})

test('a name bound to the extension keeps its shape in its module', async () => {
  const bundle = await buildProbe(
    'module-scoped-storage',
    [
      "import { createStorage } from '@opencroft/client/storage'",
      '',
      "export const probe = createStorage('notes')",
      '',
    ].join('\n'),
  )
  assert.match(bundle, /createStorage\("local\.module-scoped-storage",/)
})

test('a module the client package does not have fails the build and names the ones it has', async () => {
  const dir = path.join(root, 'extensions', 'local.absent-module')
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'src', 'client.tsx'),
    "import { NodeFrame } from '@opencroft/client/nodes'\n\nexport const probe = NodeFrame\n",
  )
  const manifest: ExtensionManifest = { id: 'local.absent-module', name: 'absent-module', version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))

  const result = await buildExtension('local.absent-module', manifest)
  assert.equal(result.success, false)
  assert.match(JSON.stringify(result.errors), /@opencroft\/client\/nodes is not a module of @opencroft\/client.*canvas/)
})

async function buildServerProbe(slug: string, serverSource: string): Promise<{ success: boolean; bundle: string }> {
  const id = `local.${slug}`
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), serverSource)
  const manifest: ExtensionManifest = { id, name: slug, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  const result = await buildExtension(id, manifest)
  const bundle = result.success ? await fs.readFile(path.join(dir, 'dist', 'server.js'), 'utf-8') : ''
  return { success: result.success, bundle }
}

test('every server module serves its host members, read off the injected host', async () => {
  // `routes`, `tools` and `lifecycle` declare contracts and serve no member.
  const serving = Object.entries(SERVER_MODULES).filter(([, names]) => names.length > 0)
  assert.ok(serving.length > 5, `expected the server modules to be read; found ${serving.length}`)
  for (const [module, names] of serving) {
    const list = names.join(', ')
    const { success, bundle } = await buildServerProbe(
      `server-${module}`,
      `import { ${list} } from '@opencroft/server/${module}'\n\nexport const actions = { probe: () => [${list}] }\n`,
    )
    assert.ok(success, `@opencroft/server/${module} must build`)
    for (const name of names) {
      assert.match(bundle, new RegExp(`\\b${name}\\b`), `${name} is forwarded by @opencroft/server/${module}`)
    }
    assert.match(bundle, /__extensionServerApi/)
  }
})

test('a name a server module does not serve fails the build', async () => {
  // The control for the test above: a module that resolved every name it was
  // asked for would pass it for members that do not exist.
  const { success } = await buildServerProbe(
    'server-absent-name',
    "import { storage } from '@opencroft/server/graph'\n\nexport const actions = { probe: () => storage }\n",
  )
  assert.equal(success, false, '`storage` is not a member of the graph module')
})

test('the server package root serves the whole host as its default export and every member by name', async () => {
  const names = Object.values(SERVER_MODULES).flat()
  const { success } = await buildServerProbe(
    'server-root',
    `import host, { ${names.join(', ')} } from '@opencroft/server'\n\nexport const actions = { probe: () => [host, ${names.join(', ')}] }\n`,
  )
  assert.ok(success, 'the package root must build with every member imported by name')
})

test('a name @ext/host binds to the extension keeps its own shape', async () => {
  // `createStorage` exists on the host object too, with the extension id as its
  // first argument — the shim's takes only a namespace and supplies the id. A
  // forward of the host key would satisfy the name and pass the surface test
  // above while handing the namespace over as the extension id.
  const bundle = await buildProbe(
    'scoped-storage',
    ["import { createStorage } from '@ext/host'", '', "export const probe = createStorage('notes')", ''].join('\n'),
  )

  assert.match(bundle, /createStorage\("local\.scoped-storage",/)
})

test('a name the host does not provide fails the build rather than becoming undefined at runtime', async () => {
  // The guard that makes the assertion above mean something: if any identifier
  // imported from the host resolved regardless of whether the shim declares it,
  // the test above would pass for a capability that does not exist.
  const dir = path.join(root, 'extensions', 'local.absent-name')
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'src', 'client.tsx'),
    "import { useSomethingTheHostDoesNotProvide } from '@ext/host'\n\nexport const probe = useSomethingTheHostDoesNotProvide\n",
  )
  const manifest: ExtensionManifest = { id: 'local.absent-name', name: 'absent-name', version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))

  const result = await buildExtension('local.absent-name', manifest)
  assert.equal(result.success, false, 'importing a name the shim does not export must not build')
})

test("a toast raised through sonner is the host's toast, not a bundled copy's", async () => {
  // A bundled sonner keeps its toasts in a store no Toaster on the page reads,
  // so the toast would vanish without an error. Read off the host is the one
  // shape in which it reaches the page's Toaster.
  const bundle = await buildProbe(
    'sonner-toast',
    ["import { toast } from 'sonner'", '', "export const probe = () => toast.success('Copied')", ''].join('\n'),
  )

  assert.match(bundle, /__extHost\.host\.toast/)
})

test('a second Toaster cannot be imported from sonner', async () => {
  const dir = path.join(root, 'extensions', 'local.sonner-toaster')
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'src', 'client.tsx'),
    "import { Toaster } from 'sonner'\n\nexport const probe = Toaster\n",
  )
  const manifest: ExtensionManifest = { id: 'local.sonner-toaster', name: 'sonner-toaster', version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))

  const result = await buildExtension('local.sonner-toaster', manifest)
  assert.equal(result.success, false, 'the host mounts the one Toaster; an extension importing its own must not build')
})
