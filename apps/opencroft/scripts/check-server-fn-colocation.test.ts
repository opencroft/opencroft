// The check this exercises exists because the previous one passed on both
// shapes it was believed to tell apart. So these tests are written to fail if
// it stops discriminating — not merely to confirm it runs.

import assert from 'node:assert/strict'
import test from 'node:test'

import { plainExportsBesideServerFn } from './check-server-fn-colocation.mjs'

const HAZARDOUS = `
import { createServerFn } from '@tanstack/react-start'
import { promises as fs } from 'node:fs'

export async function readThing(dir: string) {
  return fs.readFile(dir, 'utf-8')
}

export const loadThing = createServerFn().handler(async () => readThing('x'))
`

const SAFE = `
import { createServerFn } from '@tanstack/react-start'

import { readThing } from './thing-impl'

export const loadThing = createServerFn().handler(async () => readThing('x'))
`

// The pair the acceptance is stated in terms of. A rule that answered the same
// for both would have proved nothing, which is exactly what happened before.
test('the hazardous shape is flagged and the split shape is not', () => {
  const hazard = plainExportsBesideServerFn(HAZARDOUS)
  assert.ok(hazard, 'a plain export beside a server function must be reported')
  assert.deepEqual(hazard.plain, ['readThing'])
  assert.deepEqual(hazard.serverFns, ['loadThing'])

  assert.equal(plainExportsBesideServerFn(SAFE), null)
})

// The impl module the fix moves code INTO names `createServerFn` in its comment
// explaining why it holds none. Matching that mention would flag every correct
// split — turning the check into a reason to undo the fix it asks for.
test('a comment mentioning createServerFn does not make a file a server module', () => {
  const source = `
// Kept out of the createServerFn file so the client build can stub it.
import { promises as fs } from 'node:fs'

export async function readThing(dir: string) {
  return fs.readFile(dir, 'utf-8')
}
`
  assert.equal(plainExportsBesideServerFn(source), null)
})

// Types are erased before the bundler sees them, so they cannot hold an import
// tail open. Flagging them would make the check unusable on the many server-fn
// files that legitimately export their argument and return types.
test('exported types and interfaces beside a server function are not flagged', () => {
  const source = `
import { createServerFn } from '@tanstack/react-start'

export interface GraphData { nodes: string[] }
export type GraphId = string

export const loadGraph = createServerFn().handler(async (): Promise<GraphData> => ({ nodes: [] }))
`
  assert.equal(plainExportsBesideServerFn(source), null)
})

// `export { x }` exports a local binding and keeps it alive exactly as a direct
// export would. Missing this form would leave a way to reintroduce the hazard
// that the check reports as clean.
test('a local binding exported through an export list is flagged', () => {
  const source = `
import { createServerFn } from '@tanstack/react-start'

async function readThing() {
  return 1
}

export { readThing }

export const loadThing = createServerFn().handler(async () => readThing())
`
  const found = plainExportsBesideServerFn(source)
  assert.ok(found, 'an export list is still an export')
  assert.deepEqual(found.plain, ['readThing'])
})

// A re-export binds another module's value; this module's own imports stay
// droppable. Treating it as a plain export would be a false positive.
test('a re-export from another module is not a plain export', () => {
  const source = `
import { createServerFn } from '@tanstack/react-start'

export { readThing } from './thing-impl'

export const loadThing = createServerFn().handler(async () => 1)
`
  assert.equal(plainExportsBesideServerFn(source), null)
})

// A file with no server function has nothing to be co-located with, whatever
// else it exports.
test('a file with no server function is never flagged', () => {
  const source = `
import { promises as fs } from 'node:fs'

export async function readThing(dir: string) {
  return fs.readFile(dir, 'utf-8')
}
`
  assert.equal(plainExportsBesideServerFn(source), null)
})
