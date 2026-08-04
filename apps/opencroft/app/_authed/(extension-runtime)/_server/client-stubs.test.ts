// Exercises clientStubs against the real build pipeline (esbuild) — not
// mocked, since what this guards (a specifier resolving to empty code instead
// of esbuild's default resolver, an undeclared specifier being unaffected, an
// unmatched declaration surfacing as a build error) only exists in the real
// interaction between esbuild's onResolve/onLoad hooks and a real build.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-client-stubs-'))
process.env.OPENCROFT_LOCAL_EXTENSIONS = root

const { buildExtension } = await import('./compiler')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

let seq = 0

async function makeFixture(options: {
  clientStubs?: string[]
  clientSource: string
}): Promise<{ id: string; manifest: ExtensionManifest; dir: string }> {
  seq += 1
  const slug = `stub-${seq}`
  const dir = path.join(root, slug)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), options.clientSource)
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  const manifest: ExtensionManifest = { id: `local/${slug}`, name: slug, version: '0.0.0' }
  if (options.clientStubs) {
    manifest.clientStubs = options.clientStubs
  }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  return { id: `local/${slug}`, manifest, dir }
}

function distDir(dir: string): string {
  return path.join(dir, 'dist')
}

test('a declared specifier resolves to an empty module instead of esbuild trying to find the real package', async () => {
  // This package does not exist anywhere on disk — an unstubbed dynamic
  // import of it would fail the build with a resolution error. If the build
  // succeeds, the stub is what made that import resolve, not a real package.
  const { id, manifest, dir } = await makeFixture({
    clientStubs: ['totally-nonexistent-heavy-package'],
    clientSource:
      "export async function loadHeavy() {\n  const mod = await import('totally-nonexistent-heavy-package')\n  return mod\n}\n",
  })
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
})

test('a stub only empties the specifier it names — a normal import alongside it still bundles for real', async () => {
  const { id, manifest, dir } = await makeFixture({
    clientStubs: ['totally-nonexistent-heavy-package'],
    clientSource:
      "import { realMarker } from './real-module'\n" +
      "export async function loadHeavy() {\n  const mod = await import('totally-nonexistent-heavy-package')\n  return { mod, realMarker }\n}\n",
  })
  await fs.writeFile(
    path.join(dir, 'src', 'real-module.ts'),
    "export const realMarker = 'real-content-should-survive-marker'\n",
  )
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
  const clientJs = await fs.readFile(path.join(distDir(dir), 'client.js'), 'utf-8')
  assert.ok(
    clientJs.includes('real-content-should-survive-marker'),
    'an import not named in clientStubs must bundle for real, even in the same file as a stubbed one',
  )
})

test('a clientStubs entry that never matches an import is a build error, not a silent no-op', async () => {
  const { id, manifest, dir } = await makeFixture({
    clientStubs: ['this-specifier-is-never-imported'],
    clientSource: "export const marker = 'unrelated'\n",
  })
  const result = await buildExtension(id, manifest)
  assert.equal(result.success, false, 'an unmatched clientStubs entry must fail the build')
  assert.ok(
    result.errors.some((e) => e.message.includes('this-specifier-is-never-imported')),
    JSON.stringify(result.errors),
  )
})

test('declaring no clientStubs at all changes nothing — same as never having the field', async () => {
  const { id, manifest, dir } = await makeFixture({
    clientSource: "export const marker = 'no-stubs-declared-marker'\n",
  })
  assert.equal(manifest.clientStubs, undefined)
  const result = await buildExtension(id, manifest)
  assert.ok(result.success, JSON.stringify(result.errors))
  const clientJs = await fs.readFile(path.join(distDir(dir), 'client.js'), 'utf-8')
  assert.ok(clientJs.includes('no-stubs-declared-marker'))
})
