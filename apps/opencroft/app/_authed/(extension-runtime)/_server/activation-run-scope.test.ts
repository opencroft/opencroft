// Activating an extension from inside a run leaves nothing of that run to what
// the module keeps running: a timer its bundle starts while evaluating, and
// one its `load()` starts, both fire outside every run. Exercised through the
// real build and evaluation of a scratch fixture extension.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { flushCache, getExtensionModule } from './loader'
import { currentRunEvents, withRunEvent } from './run-scope'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-activation-run-scope-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = root

type Probe = (where: string) => void
const probeGlobal = globalThis as { __activationRunScopeProbe?: Probe }

after(async () => {
  delete probeGlobal.__activationRunScopeProbe
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  await fs.rm(root, { recursive: true, force: true })
})

/**
 * An extension that schedules a probe call from module level and from
 * `load()`. The probe is the test's own function, so it reads the run scope
 * of the callback that calls it.
 */
async function makeFixture(): Promise<string> {
  const id = 'local.activation-run-scope'
  const dir = path.join(root, 'extensions', id)
  await fs.mkdir(path.join(dir, 'server'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'server', 'index.ts'),
    `const probe = (where: string) => (globalThis as any).__activationRunScopeProbe?.(where)
setTimeout(() => probe('module'), 0)
export const actions = {}
export function load() { setTimeout(() => probe('load'), 0) }
`,
  )
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify({ id, name: id, version: '0.0.0' }))
  // Dated an hour back, as activation-race.test.ts does and for its reason: a
  // cached module is fresh while its sources are no newer than its activation.
  const when = new Date(Date.now() - 60 * 60 * 1000)
  for (const entry of ['server/index.ts', 'server', 'extension.json']) {
    await fs.utimes(path.join(dir, entry), when, when)
  }
  return id
}

test('an extension activated from inside a run starts its timers outside every run', async () => {
  const id = await makeFixture()
  const seen = new Map<string, ReturnType<typeof currentRunEvents>>()
  const bothFired = new Promise<void>((resolve) => {
    probeGlobal.__activationRunScopeProbe = (where) => {
      seen.set(where, currentRunEvents())
      if (seen.size === 2) {
        resolve()
      }
    }
  })

  const insideRun = await withRunEvent('route-1', { body: { secret: 'request body' } }, async () => {
    const events = currentRunEvents()
    await getExtensionModule(id)
    return events
  })
  await bothFired
  flushCache(id)

  // Control: the activation really was asked for from inside a run.
  assert.ok(insideRun?.has('route-1'), 'the caller was inside a run')
  assert.deepEqual([...seen.keys()].sort(), ['load', 'module'])
  // Whose events each timer sees: none, for the bundle's and for load()'s.
  const runSeen = (where: string) => [...(seen.get(where)?.keys() ?? [])]
  assert.deepEqual({ module: runSeen('module'), load: runSeen('load') }, { module: [], load: [] })
})
