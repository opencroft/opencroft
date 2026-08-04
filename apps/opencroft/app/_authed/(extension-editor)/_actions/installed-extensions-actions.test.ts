// Exercises the real filesystem against a scratch extension.json fixture — the
// defect this guards (a manifest reformatted to a fixed style on install,
// leaving every checkout permanently dirty against its source repo) only
// shows up in what actually lands on disk, not in the returned object.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { rewriteManifestId } from './installed-extensions-actions'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-manifest-rewrite-'))

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function fixture(name: string, content: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'extension.json'), content, 'utf-8')
  return dir
}

test('a 4-space-indented source manifest is rewritten with 4-space indent, not the installer default', async () => {
  const dir = await fixture(
    '4-space',
    '{\n    "id": "sample",\n    "name": "Sample",\n    "version": "1.0.0"\n}\n',
  )
  await rewriteManifestId(dir, 'local/sample')
  const written = await fs.readFile(path.join(dir, 'extension.json'), 'utf-8')
  assert.equal(written, '{\n    "id": "local/sample",\n    "name": "Sample",\n    "version": "1.0.0"\n}\n')
})

test('a compact (no whitespace) source manifest stays compact', async () => {
  const dir = await fixture('compact', '{"id":"sample","name":"Sample","version":"1.0.0"}')
  await rewriteManifestId(dir, 'local/sample')
  const written = await fs.readFile(path.join(dir, 'extension.json'), 'utf-8')
  assert.equal(written, '{"id":"local/sample","name":"Sample","version":"1.0.0"}')
})

test('a source manifest with no trailing newline gets none written back', async () => {
  const dir = await fixture('no-newline', '{\n  "id": "sample",\n  "name": "Sample",\n  "version": "1.0.0"\n}')
  await rewriteManifestId(dir, 'local/sample')
  const written = await fs.readFile(path.join(dir, 'extension.json'), 'utf-8')
  assert.ok(!written.endsWith('\n\n'))
  assert.equal(written, '{\n  "id": "local/sample",\n  "name": "Sample",\n  "version": "1.0.0"\n}')
})

test('unrelated fields and their order survive the rewrite untouched', async () => {
  const dir = await fixture(
    'field-order',
    '{\n  "name": "Sample",\n  "id": "sample",\n  "description": "does a thing",\n  "provides": ["x", "y"]\n}\n',
  )
  const manifest = await rewriteManifestId(dir, 'local/sample')
  const written = await fs.readFile(path.join(dir, 'extension.json'), 'utf-8')
  assert.equal(
    written,
    '{\n  "name": "Sample",\n  "id": "local/sample",\n  "description": "does a thing",\n  "provides": [\n    "x",\n    "y"\n  ],\n  "version": "0.0.0"\n}\n',
  )
  assert.equal(manifest.version, '0.0.0', 'a missing version is still defaulted')
})

test('an existing version is left alone, only id changes', async () => {
  const dir = await fixture('has-version', '{\n  "id": "sample",\n  "version": "2.3.4"\n}\n')
  const manifest = await rewriteManifestId(dir, 'installed/owner-sample')
  assert.equal(manifest.id, 'installed/owner-sample')
  assert.equal(manifest.version, '2.3.4')
})
