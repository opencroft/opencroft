import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readOrCreateInstanceId } from './instance-id'

function scratch(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'instance-id-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('makes an id on first use, in a directory it creates, and gives the same one after', (t) => {
  const file = path.join(scratch(t), 'nested', 'id')
  const id = readOrCreateInstanceId(file)
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal(readFileSync(file, 'utf8').trim(), id)
  assert.equal(readOrCreateInstanceId(file), id)
})

test('keeps the id a file already holds', (t) => {
  const file = path.join(scratch(t), 'id')
  writeFileSync(file, 'held-by-another-process\n')
  assert.equal(readOrCreateInstanceId(file), 'held-by-another-process')
})

test('replaces an empty file with a new id', (t) => {
  const file = path.join(scratch(t), 'id')
  writeFileSync(file, '')
  const id = readOrCreateInstanceId(file)
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal(readFileSync(file, 'utf8').trim(), id)
})
