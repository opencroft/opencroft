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

test('a burst of late arrivals shares one follow-up build, not one each', async () => {
  const { id, manifest } = await makeFixture(largeClientSource('dedup-'))

  // Every arrival here is synchronous relative to the first, so all three
  // must join the SAME in-flight slot rather than each timing their own race
  // against it. Late arrivals always get a re-checked build (never the first
  // caller's own result — see the mid-edit test below for why), but that
  // re-check must be shared among them, not run once per late arrival.
  const [first, lateA, lateB, lateC] = await Promise.all([
    buildExtension(id, manifest),
    buildExtension(id, manifest),
    buildExtension(id, manifest),
    buildExtension(id, manifest),
  ])
  assert.ok(first.success, `first build failed: ${JSON.stringify(first.errors)}`)
  for (const late of [lateA, lateB, lateC]) {
    assert.ok(late.success, `late build failed: ${JSON.stringify(late.errors)}`)
    assert.equal(late, lateA, 'every late arrival must share the exact same follow-up result, not one each')
  }

  // A later, non-concurrent call is a fresh build, not a stale dedup entry.
  const after = await buildExtension(id, manifest)
  assert.ok(after.success, `later build failed: ${JSON.stringify(after.errors)}`)
  assert.notEqual(after, first, 'a call after everything has settled must not still be deduped against the first')
})

test('a source edit that lands mid-build is not lost to a late caller', async () => {
  const { id, manifest } = await makeFixture(largeClientSource('before-'))
  const srcFile = path.join(root, id.split('/')[1], 'src', 'client.tsx')

  // `late` arrives synchronously behind `first`, so it is guaranteed to join
  // the same in-flight slot rather than race it — this test is about what
  // happens next, not about winning that timing. The fixture is large enough
  // that `first`'s own esbuild pass is still running tens of milliseconds in,
  // which is when the edit below lands.
  const first = buildExtension(id, manifest)
  const late = buildExtension(id, manifest)
  await new Promise((resolve) => setTimeout(resolve, 10))
  await fs.writeFile(srcFile, largeClientSource('after-'))

  const [firstResult, lateResult] = await Promise.all([first, late])
  assert.ok(firstResult.success, `first build failed: ${JSON.stringify(firstResult.errors)}`)
  assert.ok(lateResult.success, `late build failed: ${JSON.stringify(lateResult.errors)}`)
  assert.notEqual(firstResult, lateResult, "the late caller must not be handed the stale build's own result")

  const published = await fs.readFile(distFile(id, 'client.js'), 'utf-8')
  assert.ok(published.includes('after-'), 'the published bundle must reflect the edit')
  assert.ok(
    !published.includes('before-'),
    'the published bundle must not still be serving what the first build started with',
  )
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
