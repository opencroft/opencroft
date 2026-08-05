// Exercises the icon-usage check against the real build pipeline (esbuild),
// same reasoning as client-stubs.test.ts: what this guards only exists in the
// real interaction between the plugin's onLoad hook and a real build, not in
// a mock of it.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-icon-usage-'))
process.env.OPENCROFT_LOCAL_EXTENSIONS = root

const { buildExtension } = await import('./compiler')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

let seq = 0

async function makeFixture(clientSource: string): Promise<{ id: string; manifest: ExtensionManifest }> {
  seq += 1
  const slug = `icon-usage-${seq}`
  const dir = path.join(root, slug)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), clientSource)
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  const manifest: ExtensionManifest = { id: `local/${slug}`, name: slug, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  return { id: `local/${slug}`, manifest }
}

test('a real icon name, referenced by member access, builds clean', async () => {
  const { id, manifest } = await makeFixture(
    "import * as icons from 'lucide-react'\nexport const marker = icons.House\n",
  )
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
})

test('a name that is not a real icon export, referenced by member access, fails the build and names the offender', async () => {
  const { id, manifest } = await makeFixture(
    "import * as icons from 'lucide-react'\nexport const marker = icons.ThisIconDoesNotExist\n",
  )
  const result = await buildExtension(id, manifest)
  assert.equal(result.success, false, 'a nonexistent icon name must fail the build')
  assert.ok(
    result.errors.some((e) => e.message.includes('icons.ThisIconDoesNotExist')),
    JSON.stringify(result.errors),
  )
})

test('a name that is not a real icon export, destructured out of icons, fails the build the same way', async () => {
  const { id, manifest } = await makeFixture(
    "import * as icons from 'lucide-react'\nconst { ThisIconAlsoDoesNotExist } = icons\nexport const marker = ThisIconAlsoDoesNotExist\n",
  )
  const result = await buildExtension(id, manifest)
  assert.equal(result.success, false, 'a nonexistent destructured icon name must fail the build')
  assert.ok(
    result.errors.some((e) => e.message.includes('ThisIconAlsoDoesNotExist')),
    JSON.stringify(result.errors),
  )
})

test('a real icon destructured alongside a fake one only flags the fake one', async () => {
  const { id, manifest } = await makeFixture(
    "import * as icons from 'lucide-react'\nconst { House, ThisOneIsFake } = icons\nexport const marker = { House, ThisOneIsFake }\n",
  )
  const result = await buildExtension(id, manifest)
  assert.equal(result.success, false)
  assert.ok(!result.errors.some((e) => e.message.includes('icons.House') || e.message.includes(' House ')))
  assert.ok(result.errors.some((e) => e.message.includes('ThisOneIsFake')))
})

test('icons.LucideIcon in a type position is a real TypeScript type on the namespace, not a component name, and must not fail the build', async () => {
  const { id, manifest } = await makeFixture(
    "import * as icons from 'lucide-react'\ninterface Props {\n  icon: icons.LucideIcon\n}\nexport const marker: Props = { icon: icons.House }\n",
  )
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
})
