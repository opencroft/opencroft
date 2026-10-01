// Exercises the real build pipeline (esbuild + Tailwind) against a scratch
// fixture extension — not mocked, since the defects this guards (a duplicate
// build, a reader catching esbuild's own write mid-flight) only exist in the
// real interaction between concurrent callers and the filesystem.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { buildExtension } from './compiler'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-build-race-'))
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
  const id = `local.sample-${seq}`
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'client.tsx'), clientSource)
  await fs.writeFile(path.join(dir, 'server', 'index.ts'), 'export const actions = {}\n')
  const manifest = { id, name: id, version: '0.0.0' }
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest))
  return { id, manifest }
}

function distFile(extensionId: string, name: string): string {
  return path.join(root, 'extensions', extensionId, 'dist', name)
}

// Resolves once a build of this extension has reached the point of staging its
// output, which is the observable proof that esbuild has already read the
// source — so an edit made after this is genuinely an edit the running build
// missed, rather than one it might still pick up.
//
// `settled` is what keeps this from waiting forever: if the build finishes
// before any staging is seen, the caller is told the window was missed instead
// of being left to hang or to assert against a race it never entered.
//
// The trade, named rather than hidden: this reads the directory continuously
// for the whole compile, so it puts real I/O on a machine during a test about
// behaviour under load. A delay between reads would cost less and reintroduce
// a guess about how long the window is, which is the thing being removed.
async function stagedOrSettled(extensionId: string, build: Promise<unknown>): Promise<'staged' | 'settled'> {
  const dist = path.dirname(distFile(extensionId, 'client.js'))
  let settled = false
  const done = build.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  while (!settled) {
    const entries = await fs.readdir(dist).catch(() => [] as string[])
    if (entries.some((entry) => entry.includes('.building-'))) {
      return 'staged'
    }
  }
  await done
  return 'settled'
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
  const srcFile = path.join(root, 'extensions', id, 'src', 'client.tsx')

  // `late` arrives synchronously behind `first`, so it is guaranteed to join
  // the same in-flight slot rather than race it — this test is about what
  // happens next, not about winning that timing.
  //
  // The edit has to land inside a window: late enough that the running build
  // has already read the source, early enough that the follow-up has not
  // started. Ten milliseconds was a guess at the middle of it, and under load
  // it lands too EARLY — while esbuild is still reading a four-megabyte source
  // file, which then fails to parse mid-string and the whole build errors on
  // "Unterminated string literal". Reproduced by running this file against a
  // loaded machine: one failure in six.
  //
  // Waiting for the build to stage its output is that window's opening
  // expressed as something observable — staged output is proof the source has
  // already been read in full.
  const first = buildExtension(id, manifest)
  const late = buildExtension(id, manifest)
  const reached = await stagedOrSettled(id, first)
  assert.equal(reached, 'staged', 'the first build finished before the edit could land, so nothing was raced')
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

  // Every side of a build stages inside `dist` under a `.building-` name and is
  // published by renaming out of it, so a build in progress is visible as a
  // staging entry of `dist` itself.
  const stagingParent = path.dirname(clientFile)

  // Published once first, for the same reason the split suite's version does
  // it: on a fresh fixture neither file exists until the build's last act, so
  // a reader racing that build reads nothing on every pass and the assertions
  // below never execute. What a partial read is possible DURING is a rebuild
  // — a bundle already being served while its replacement stages.
  const published = await buildExtension(id, manifest)
  assert.ok(published.success, `first build failed: ${JSON.stringify(published.errors)}`)

  let sawStaging = false
  let reads = 0
  const inspect = async () => {
    const siblings = await fs.readdir(stagingParent).catch(() => [] as string[])
    if (siblings.some((f) => f.includes('.building-'))) {
      sawStaging = true
    }
    const code = await fs.readFile(clientFile, 'utf-8').catch(() => null)
    if (code !== null) {
      reads += 1
      assert.ok(code.includes('atomic-'), 'a reader must never see a truncated prefix of the bundle')
      assert.match(code, /sourceMappingURL=client\.js\.map\?v=\d+\n$/, 'must be a complete, well-formed bundle')
    }
    const map = await fs.readFile(mapFile, 'utf-8').catch(() => null)
    if (map !== null) {
      assert.doesNotThrow(() => JSON.parse(map), 'a reader must never see a truncated sourcemap')
    }
  }

  // Bounded by the build, not by a count of iterations. A fixed count is a
  // guess about which finishes first, and when the guess loses the poller has
  // stopped before the build even reached its publish — leaving the guard
  // below to fail a run that never got the chance to observe anything.
  let building = true
  const poll = (async () => {
    while (building) {
      await inspect()
    }
  })()

  const result = await buildExtension(id, manifest)
  building = false
  await poll

  assert.ok(result.success, `build failed: ${JSON.stringify(result.errors)}`)
  assert.ok(reads > 0, 'the poller must have actually read the published bundle while the rebuild ran')
  assert.ok(
    sawStaging,
    'the poller must have actually observed the build in progress (staging directory present) for this test to mean anything',
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

  await fs.writeFile(path.join(root, 'extensions', id, 'src', 'client.tsx'), 'export default {\n')
  const broken = await buildExtension(id, manifest)
  assert.equal(broken.success, false)

  const after = await fs.readFile(clientFile, 'utf-8')
  assert.equal(after, before, 'a failed rebuild must leave the previously published bundle exactly as it was')
  const leftovers = (await fs.readdir(path.dirname(clientFile))).filter((f) => f.includes('.building-'))
  assert.deepEqual(leftovers, [], 'a failed build must not leave temp files behind')
})
