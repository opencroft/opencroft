// Exercises the icon-usage check against the real build pipeline (esbuild),
// same reasoning as client-stubs.test.ts: what this guards only exists in the
// real interaction between the plugin's onLoad hook and a real build, not in
// a mock of it.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'
import { buildExtension } from './compiler'

const lucideVersion: string = createRequire(import.meta.url)('lucide-react/package.json').version

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-icon-usage-'))
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

let seq = 0

async function makeFixture(clientSource: string): Promise<{ id: string; manifest: ExtensionManifest }> {
  seq += 1
  const id = `local.icon-usage-${seq}`
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), clientSource)
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  const manifest: ExtensionManifest = { id, name: id, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  return { id, manifest }
}

test('a real icon name, referenced by member access, builds clean', async () => {
  const { id, manifest } = await makeFixture(
    "import * as icons from 'lucide-react'\nexport const marker = icons.House\n",
  )
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
})

test('a name that is not a real icon export, referenced by member access, fails the build naming the offender and the host Lucide version', async () => {
  const { id, manifest } = await makeFixture(
    "import * as icons from 'lucide-react'\nexport const marker = icons.ThisIconDoesNotExist\n",
  )
  const result = await buildExtension(id, manifest)
  assert.equal(result.success, false, 'a nonexistent icon name must fail the build')
  const error = result.errors.find((e) => e.message.includes('ThisIconDoesNotExist'))
  assert.ok(error, JSON.stringify(result.errors))
  assert.ok(error.message.includes(`lucide-react ${lucideVersion}`), error.message)
})

test('an icon Lucide added after 1.14 builds against the host icon set', async () => {
  const { id, manifest } = await makeFixture(
    "import { FaceSlightlySmiling } from 'lucide-react'\nexport const marker = FaceSlightlySmiling\n",
  )
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
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

test('lucide-react is the host icon set: the bundle carries no icon of its own and records the icons it names', async () => {
  const { id, manifest } = await makeFixture(
    "import { House, ArrowRight as Next } from 'lucide-react'\nimport * as icons from 'lucide-react'\nexport const marker = [House, Next, icons.Rocket]\n",
  )
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
  const dist = path.join(root, 'extensions', id, 'dist')
  const bundle = await fs.readFile(path.join(dist, 'client.js'), 'utf-8')
  assert.match(bundle, /__extHost\.host\.icons/)
  // Every Lucide icon is drawn with these attributes; a bundled copy carries them.
  assert.doesNotMatch(bundle, /strokeLinecap/)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dist, 'icons.json'), 'utf-8')), [
    'ArrowRight',
    'House',
    'Rocket',
  ])
})

test('a name imported from lucide-react that is not a real icon export fails the build', async () => {
  const { id, manifest } = await makeFixture(
    "import { House, ThisImportIsFake } from 'lucide-react'\nexport const marker = [House, ThisImportIsFake]\n",
  )
  const result = await buildExtension(id, manifest)
  assert.equal(result.success, false)
  assert.ok(
    result.errors.some((e) => e.message.includes('ThisImportIsFake')),
    JSON.stringify(result.errors),
  )
})

test('icons.LucideIcon in a type position is a real TypeScript type on the namespace, not a component name, and must not fail the build', async () => {
  const { id, manifest } = await makeFixture(
    "import * as icons from 'lucide-react'\ninterface Props {\n  icon: icons.LucideIcon\n}\nexport const marker: Props = { icon: icons.House }\n",
  )
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
})
