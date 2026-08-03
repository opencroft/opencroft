// Exercises the real build pipeline (esbuild + Tailwind) against a scratch
// fixture extension — not mocked, since the defects this guards (a duplicate
// build, a reader catching esbuild's own write mid-flight) only exist in the
// real interaction between concurrent callers and the filesystem.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-build-race-'))
process.env.OPENCROFT_LOCAL_EXTENSIONS = root

const { buildExtension } = await import('./compiler')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

let seq = 0

// A large client entry so esbuild's own write genuinely spans multiple event
// loop turns — the same reasoning as source-map-link.test.ts's 4MB body.
// Too small and a partial-read test passes by accident, not by the fix.
function largeClientSource(marker: string): string {
  const blob = `${marker}${'z'.repeat(4_000_000)}`
  return `export default ${JSON.stringify({ blob })}\n`
}

async function makeFixture(
  clientSource: string,
): Promise<{ id: string; manifest: { id: string; name: string; version: string } }> {
  seq += 1
  const slug = `sample-${seq}`
  const dir = path.join(root, slug)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), clientSource)
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  const manifest = { id: `local/${slug}`, name: slug, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  return { id: `local/${slug}`, manifest }
}

function distFile(extensionId: string, name: string): string {
  const slug = extensionId.split('/')[1]
  return path.join(root, slug, 'dist', name)
}

test('concurrent builds of the same extension share one build, not two', async () => {
  const { id, manifest } = await makeFixture(largeClientSource('dedup-'))

  const [a, b] = await Promise.all([buildExtension(id, manifest), buildExtension(id, manifest)])
  assert.ok(a.success, `first build failed: ${JSON.stringify(a.errors)}`)
  assert.equal(a, b, 'two concurrent callers must be handed the exact same result, not two separately-built ones')

  // A later, non-concurrent call is a fresh build, not a stale dedup entry.
  const c = await buildExtension(id, manifest)
  assert.ok(c.success, `second build failed: ${JSON.stringify(c.errors)}`)
  assert.notEqual(c, a, 'a call after the first has settled must not still be deduped against it')
})

test('a concurrent reader never sees a partial client bundle or map', async () => {
  const { id, manifest } = await makeFixture(largeClientSource('atomic-'))
  const clientFile = distFile(id, 'client.js')
  const mapFile = distFile(id, 'client.js.map')

  let sawTemp = false
  const poll = (async () => {
    for (let i = 0; i < 500; i += 1) {
      const entries = await fs.readdir(path.dirname(clientFile)).catch(() => [] as string[])
      if (entries.some((f) => f.includes('.building-'))) {
        sawTemp = true
      }
      const code = await fs.readFile(clientFile, 'utf-8').catch(() => null)
      if (code !== null) {
        assert.ok(code.includes('atomic-'), 'a reader must never see a truncated prefix of the bundle')
        assert.match(code, /sourceMappingURL=client\.js\.map\?v=\d+\n$/, 'must be a complete, well-formed bundle')
      }
      const map = await fs.readFile(mapFile, 'utf-8').catch(() => null)
      if (map !== null) {
        assert.doesNotThrow(() => JSON.parse(map), 'a reader must never see a truncated sourcemap')
      }
    }
  })()

  const result = await buildExtension(id, manifest)
  await poll

  assert.ok(result.success, `build failed: ${JSON.stringify(result.errors)}`)
  assert.ok(
    sawTemp,
    'the poller must have actually observed the build in progress (temp file present) for this test to mean anything',
  )
  const finalCode = await fs.readFile(clientFile, 'utf-8')
  assert.ok(
    finalCode.includes('atomic-') && finalCode.length > 4_000_000,
    'the published bundle must be the whole thing',
  )
  const leftovers = (await fs.readdir(path.dirname(clientFile))).filter((f) => f.includes('.building-'))
  assert.deepEqual(leftovers, [], 'no temp files may remain after a successful publish')
})

test('a build with a syntax error leaves no temp files and does not touch a previous good bundle', async () => {
  const { id, manifest } = await makeFixture(largeClientSource('good-'))
  const good = await buildExtension(id, manifest)
  assert.ok(good.success, `setup build failed: ${JSON.stringify(good.errors)}`)
  const clientFile = distFile(id, 'client.js')
  const before = await fs.readFile(clientFile, 'utf-8')

  await fs.writeFile(path.join(root, id.split('/')[1], 'src', 'client.tsx'), 'export default {\n')
  const broken = await buildExtension(id, manifest)
  assert.equal(broken.success, false)

  const after = await fs.readFile(clientFile, 'utf-8')
  assert.equal(after, before, 'a failed rebuild must leave the previously published bundle exactly as it was')
  const leftovers = (await fs.readdir(path.dirname(clientFile))).filter((f) => f.includes('.building-'))
  assert.deepEqual(leftovers, [], 'a failed build must not leave temp files behind')
})
