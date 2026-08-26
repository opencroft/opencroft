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
import { extensionHostApi, extensionUiApi } from '@/app/_authed/(extension-runtime)/_client/host'
import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-host-api-'))
process.env.OPENCROFT_LOCAL_EXTENSIONS = root

const { buildExtension } = await import('./compiler')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function buildProbe(slug: string, clientSource: string): Promise<string> {
  const dir = path.join(root, slug)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), clientSource)
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  const manifest: ExtensionManifest = { id: `local/${slug}`, name: slug, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  const result = await buildExtension(`local/${slug}`, manifest)
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

test('a name @ext/host binds to the extension keeps its own shape', async () => {
  // `createStorage` exists on the host object too, with the extension id as its
  // first argument — the shim's takes only a namespace and supplies the id. A
  // forward of the host key would satisfy the name and pass the surface test
  // above while handing the namespace over as the extension id.
  const bundle = await buildProbe(
    'scoped-storage',
    ["import { createStorage } from '@ext/host'", '', "export const probe = createStorage('notes')", ''].join('\n'),
  )

  assert.match(bundle, /createStorage\("local\/scoped-storage",/)
})

test('a name the host does not provide fails the build rather than becoming undefined at runtime', async () => {
  // The guard that makes the assertion above mean something: if any identifier
  // imported from the host resolved regardless of whether the shim declares it,
  // the test above would pass for a capability that does not exist.
  const dir = path.join(root, 'absent-name')
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'src', 'client.tsx'),
    "import { useSomethingTheHostDoesNotProvide } from '@ext/host'\n\nexport const probe = useSomethingTheHostDoesNotProvide\n",
  )
  const manifest: ExtensionManifest = { id: 'local/absent-name', name: 'absent-name', version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))

  const result = await buildExtension('local/absent-name', manifest)
  assert.equal(result.success, false, 'importing a name the shim does not export must not build')
})
