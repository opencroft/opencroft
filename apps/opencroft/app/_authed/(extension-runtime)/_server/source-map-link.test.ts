// The sourcemap link rewrite that lets an external map be cached as safely as
// the bundle it belongs to. Run directly with
//   node_modules/.bin/tsx --test 'app/(extension-runtime)/_server/source-map-link.test.ts'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { versionSourceMapLink } from './compiler'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-link-'))

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

let seq = 0
async function bundle(code: string, map: string | null, mapMtimeMs?: number): Promise<string> {
  const dir = path.join(root, `case-${seq++}`)
  await fs.mkdir(dir, { recursive: true })
  const js = path.join(dir, 'client.js')
  await fs.writeFile(js, code)
  if (map !== null) {
    const mapFile = `${js}.map`
    await fs.writeFile(mapFile, map)
    if (mapMtimeMs !== undefined) {
      const when = new Date(mapMtimeMs)
      await fs.utimes(mapFile, when, when)
    }
  }
  return js
}

test('the link is stamped with the map file mtime', async () => {
  const js = await bundle('code;\n//# sourceMappingURL=client.js.map\n', '{}', 1_700_000_000_000)
  await versionSourceMapLink(js)
  assert.equal(await fs.readFile(js, 'utf-8'), 'code;\n//# sourceMappingURL=client.js.map?v=1700000000000\n')
})

test('the version tracks the MAP, not the bundle', async () => {
  // The rewrite necessarily changes the bundle's own mtime, so keying the
  // version off the bundle would invalidate it in the act of writing it.
  const js = await bundle('code;\n//# sourceMappingURL=client.js.map\n', '{}', 1_700_000_000_000)
  await versionSourceMapLink(js)
  const first = await fs.readFile(js, 'utf-8')
  await versionSourceMapLink(js)
  assert.equal(await fs.readFile(js, 'utf-8'), first, 'a second pass must be a no-op, not a new version')
})

test('rebuilding the map produces a new link', async () => {
  const js = await bundle('code;\n//# sourceMappingURL=client.js.map\n', '{}', 1_700_000_000_000)
  await versionSourceMapLink(js)
  const before = await fs.readFile(js, 'utf-8')
  const when = new Date(1_800_000_000_000)
  await fs.utimes(`${js}.map`, when, when)
  await versionSourceMapLink(js)
  const afterText = await fs.readFile(js, 'utf-8')
  assert.notEqual(afterText, before)
  assert.ok(afterText.includes('?v=1800000000000'))
})

test('a bundle with no map on disk is left alone', async () => {
  // A failed build writes nothing; rewriting the previous bundle's link to
  // point at a version that does not exist would break debugging on the
  // bundle that is still being served.
  const original = 'code;\n//# sourceMappingURL=client.js.map\n'
  const js = await bundle(original, null)
  await versionSourceMapLink(js)
  assert.equal(await fs.readFile(js, 'utf-8'), original)
})

test('a bundle with no link at all is left alone', async () => {
  const original = 'code without any sourcemap comment;\n'
  const js = await bundle(original, '{}', 1_700_000_000_000)
  await versionSourceMapLink(js)
  assert.equal(await fs.readFile(js, 'utf-8'), original)
})

test('only the final link is rewritten', async () => {
  // Bundled dependencies can carry their own sourceMappingURL comments in
  // their source text; esbuild's own link is the last one in the file.
  const js = await bundle(
    'a();\n//# sourceMappingURL=vendor.js.map\nb();\n//# sourceMappingURL=client.js.map\n',
    '{}',
    1_700_000_000_000,
  )
  await versionSourceMapLink(js)
  const out = await fs.readFile(js, 'utf-8')
  assert.ok(out.includes('//# sourceMappingURL=vendor.js.map\n'), 'an inner comment must survive untouched')
  assert.ok(out.endsWith('//# sourceMappingURL=client.js.map?v=1700000000000\n'))
})

test('a concurrent reader never sees a partial bundle', async () => {
  // The failure this guards: the route serving client.js can read while a
  // rebuild rewrites it, and a partial read of a multi-megabyte bundle reaches
  // the browser as "SyntaxError: Unexpected end of input". Big enough that an
  // in-place write would not complete between reads.
  const body = `${'x'.repeat(4_000_000)};\n`
  const js = await bundle(`${body}//# sourceMappingURL=client.js.map\n`, '{}', 1_700_000_000_000)

  // Poll the file throughout the rewrite. Every observation must be a WHOLE
  // bundle — the pre-stamp one or the stamped one — never a prefix of either.
  // What the reader must be able to say afterwards is that it watched the file
  // CHANGE. Counting reads cannot say that: the rewrite is a write to a temp
  // and a rename, so every read returns a whole bundle whatever the timing,
  // and a reader whose reads all landed before the rename passes the
  // no-truncation assertion below having observed nothing of the rewrite it
  // exists to police. Seeing both states is what makes it an observation --
  // any torn read would have had to happen between them.
  let shortest = Number.POSITIVE_INFINITY
  let sawUnstamped = false
  let sawStamped = false
  const observe = async () => {
    const seen = await fs.readFile(js, 'utf-8').catch(() => null)
    if (seen === null) {
      return
    }
    shortest = Math.min(shortest, seen.length)
    if (/client\.js\.map\?v=\d+\n$/.test(seen)) {
      sawStamped = true
    } else {
      sawUnstamped = true
    }
  }

  // Bounded by the rewrite, not by a count of iterations: a count is a guess
  // about which of the two finishes first, and when it loses the reader has
  // stopped before the rewrite began.
  let rewriting = true
  const reader = (async () => {
    while (rewriting) {
      await observe()
    }
  })()

  await versionSourceMapLink(js)
  rewriting = false
  await reader
  // One read after the rewrite has resolved, because the read still in flight
  // when the rename landed opened the file before it and returns the old
  // contents -- so the loop alone can miss the change by exactly one read.
  // Deterministic rather than hopeful: the function has returned, so the
  // rename has happened, so this sees the stamped bundle or there isn't one.
  await observe()

  // Both can fail, each for its own reason. Without the first the reader
  // arrived after everything had already happened and watched nothing; without
  // the second the rewrite never produced a stamped bundle at all.
  assert.ok(sawUnstamped, 'the reader never saw the bundle before it was stamped, so it watched nothing change')
  assert.ok(sawStamped, 'the rewrite never produced a stamped bundle')
  // Both valid states end with a sourceMappingURL line and contain the whole
  // body; a truncated read is shorter than the body alone.
  assert.ok(shortest > body.length, `saw a truncated bundle of ${shortest} bytes (body alone is ${body.length})`)
  assert.match(await fs.readFile(js, 'utf-8'), /client\.js\.map\?v=1700000000000\n$/)
})

test('a successful rewrite leaves no temp file behind', async () => {
  // Named for what it actually exercises. The cleanup on the throwing path is
  // covered by inspection, not by this — forcing rename to fail needs an fs
  // stub, and a test that enters a different path than its name claims is
  // worse than an honest gap.
  const js = await bundle('code;\n//# sourceMappingURL=client.js.map\n', '{}', 1_700_000_000_000)
  await versionSourceMapLink(js)
  const strays = (await fs.readdir(path.dirname(js))).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(strays, [], 'temp files must not accumulate in dist')
})

test('two rewrites of one bundle at once cannot promote a half-written file', async () => {
  // buildExtension dedupes concurrent builds of the same extension, but this
  // function takes a bare file path and has no idea whether its caller did —
  // it has to be safe on its own. With a temp name shared between concurrent
  // calls, one rename publishes the other's partially-written file —
  // atomically, which makes it worse than the bug this fix replaces: a
  // truncated bundle that arrives looking whole. Large enough that the writes
  // genuinely overlap.
  const body = `${'y'.repeat(4_000_000)};\n`
  const js = await bundle(`${body}//# sourceMappingURL=client.js.map\n`, '{}', 1_700_000_000_000)

  await Promise.all([versionSourceMapLink(js), versionSourceMapLink(js), versionSourceMapLink(js)])

  const final = await fs.readFile(js, 'utf-8')
  assert.ok(final.startsWith(body), 'the published bundle must contain the whole body')
  assert.match(final, /client\.js\.map\?v=1700000000000\n$/)
  const strays = (await fs.readdir(path.dirname(js))).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(strays, [], 'every rewrite must clean up its own temp file')
})
