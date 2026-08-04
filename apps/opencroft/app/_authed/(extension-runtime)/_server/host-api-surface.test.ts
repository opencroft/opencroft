// What an extension receives from the host is two enumerations that have to
// agree: the object the host exports, and the generated shim the extension
// actually imports. Nothing links them, so a name can be added to one and
// missed in the other — and that failure is invisible from inside an
// extension, which finds the capability `undefined` at runtime while its build
// stays green.
//
// This exercises the real build, so the wiring is read out of the emitted
// bundle rather than assumed from the source of the shim.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

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
  // quietly resolved to nothing — reading the property is the shim's whole job.
  assert.match(bundle, /\.useUrlParam/)
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
