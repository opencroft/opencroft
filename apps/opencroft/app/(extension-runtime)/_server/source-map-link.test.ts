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
