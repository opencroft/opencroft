// An extension compiles with its own tsconfig or none, never one from a folder
// above it. The builtins are where this bites: in a source checkout their
// sources sit under the app's tsconfig, whose `@/` paths the production image
// does not ship, so a builtin that leans on them builds here and fails there.
// Real esbuild builds, since what is under test is which tsconfig esbuild reads.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { buildExtensionAt } from './compiler'
import { builtinSourceRoot } from './paths'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-tsconfig-'))
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

const ALIAS_TSCONFIG = JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } })

async function write(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
}

/** A client-only extension at `dir` whose entry imports `@/lib/value`. */
async function aliasImportingExtension(dir: string) {
  const id = `local.${path.basename(dir)}`
  await write(path.join(dir, 'src', 'client.ts'), "import { value } from '@/lib/value'\nexport default { value }\n")
  return {
    location: { extensionId: id, sourceDir: dir, distDir: path.join(dir, 'dist') },
    manifest: { id, name: id, version: '0.0.0' },
  }
}

// The app's tsconfig sits above the builtins in this checkout, so this fails
// only if the compiler stopped reading it, the way the image builds.
test('the builtin core extension builds without the app tsconfig above it', async () => {
  const sourceDir = path.join(builtinSourceRoot(), 'core')
  const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, 'extension.json'), 'utf-8'))

  const result = await buildExtensionAt(
    { extensionId: 'builtin.core', sourceDir, distDir: path.join(root, 'builtin-core-dist') },
    manifest,
  )

  assert.deepEqual(result.errors, [])
  assert.equal(result.success, true)
})

test('an extension does not resolve paths from a tsconfig above its folder', async () => {
  const host = path.join(root, 'host')
  await write(path.join(host, 'tsconfig.json'), ALIAS_TSCONFIG)
  await write(path.join(host, 'lib', 'value.ts'), 'export const value = 1\n')
  const { location, manifest } = await aliasImportingExtension(path.join(host, 'extensions', 'nested'))

  const result = await buildExtensionAt(location, manifest)

  assert.equal(result.success, false)
  assert.match(result.errors.map((error) => error.message).join('\n'), /Could not resolve "@\/lib\/value"/)
})

test('an extension resolves paths from its own tsconfig', async () => {
  const dir = path.join(root, 'own')
  await write(path.join(dir, 'tsconfig.json'), ALIAS_TSCONFIG)
  await write(path.join(dir, 'lib', 'value.ts'), 'export const value = 1\n')
  const { location, manifest } = await aliasImportingExtension(dir)

  const result = await buildExtensionAt(location, manifest)

  assert.deepEqual(result.errors, [])
  assert.equal(result.success, true)
})
