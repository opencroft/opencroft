// Regression guard: an extension's bare `react-dom` import used to compile
// to a stub whose createPortal always returned null, which silently broke any
// bundled library (radix-ui's Portal, used by ContextMenu/DropdownMenu/etc.)
// that portals internally -- the trigger's own state still flipped, since
// that's plain React state, but nothing ever mounted, with no error. Exercises
// the real build pipeline, the same way client-stubs.test.ts does, since this
// only exists in the interaction between esbuild's onResolve/onLoad hooks and
// a real build, not in a unit that could be tested in isolation.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'
import { buildExtension } from './compiler'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-react-dom-shim-'))
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

async function makeFixture(clientSource: string): Promise<{ id: string; manifest: ExtensionManifest; dir: string }> {
  seq += 1
  const id = `local.react-dom-shim-${seq}`
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), clientSource)
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  const manifest: ExtensionManifest = { id, name: id, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  return { id, manifest, dir }
}

function distDir(dir: string): string {
  return path.join(dir, 'dist')
}

test("an extension's bare react-dom import forwards createPortal to the host's real one, not a stub that discards it", async () => {
  const { id, manifest, dir } = await makeFixture(
    "import { createPortal } from 'react-dom'\nexport function usesPortal() {\n  return typeof createPortal\n}\n",
  )
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
  const clientJs = await fs.readFile(path.join(distDir(dir), 'client.js'), 'utf-8')
  assert.ok(
    clientJs.includes('__extHost.host.createPortal'),
    "createPortal must forward to globalThis.__extHost.host.createPortal (the host app's real react-dom createPortal)",
  )
  assert.ok(
    !/createPortal\s*=\s*\(\)\s*=>\s*null/.test(clientJs),
    'createPortal must not compile to a stub that always returns null -- that silently breaks any bundled library that portals internally',
  )
})

test('flushSync stays a synchronous call-through, not a hard failure', async () => {
  // Minification is free to rename the local binding, so this only asserts
  // the build still succeeds with flushSync imported and called -- the same
  // guarantee client-stubs.test.ts leans on for a stubbed specifier, just
  // without a literal marker string (nothing here is static content to keep).
  const { id, manifest } = await makeFixture(
    "import { flushSync } from 'react-dom'\nexport function run(fn) {\n  return flushSync(fn)\n}\n",
  )
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
})
