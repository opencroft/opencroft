// What `t.mock.timers` fakes under this repo's runner: Node, `tsx --test` and
// the jsdom environment from dom-environment.ts. The testing rules cite these
// results, so a Node, tsx or jsdom upgrade that changes one turns this red.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import * as timersPromises from 'node:timers/promises'
import { setTimeout as namedSleep } from 'node:timers/promises'

import { installDomEnvironment } from './dom-environment'

// Taken before any test enables the mock.
const capturedSetTimeout = globalThis.setTimeout

const dom = await installDomEnvironment()
after(() => dom.cleanup())

test('tick advances the global setTimeout, setInterval and Date', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 })
  const fired: string[] = []
  setTimeout(() => fired.push('timeout'), 100)
  const interval = setInterval(() => fired.push('interval'), 100)

  t.mock.timers.tick(99)
  assert.deepEqual(fired, [], 'nothing before the delay')
  assert.equal(Date.now(), 1_099)
  t.mock.timers.tick(1)
  assert.deepEqual(fired, ['timeout', 'interval'])
  t.mock.timers.tick(100)
  assert.deepEqual(fired, ['timeout', 'interval', 'interval'], 'the interval repeats')
  clearInterval(interval)
})

test("tick advances jsdom's window.setTimeout and requestAnimationFrame", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const fired: string[] = []
  window.setTimeout(() => fired.push('window.setTimeout'), 100)
  requestAnimationFrame(() => fired.push('requestAnimationFrame'))

  assert.deepEqual(fired, [])
  t.mock.timers.tick(100)
  assert.deepEqual(fired.sort(), ['requestAnimationFrame', 'window.setTimeout'])
})

test('not faked: node:timers/promises, AbortSignal.timeout and a setTimeout taken before enable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const fired: string[] = []
  const arrivals = [
    namedSleep(30).then(() => fired.push('named import')),
    timersPromises.setTimeout(30).then(() => fired.push('namespace import')),
    new Promise<void>((resolve) => {
      AbortSignal.timeout(30).addEventListener('abort', () => {
        fired.push('AbortSignal.timeout')
        resolve()
      })
    }),
    new Promise<void>((resolve) => {
      capturedSetTimeout(() => {
        fired.push('captured setTimeout')
        resolve()
      }, 30)
    }),
  ]

  t.mock.timers.tick(60_000)
  await Promise.resolve()
  assert.deepEqual(fired, [], 'a tick fires none of them')

  // Each still fires, on real time: the zero above is not a broken probe.
  await Promise.all(arrivals)
  assert.deepEqual(fired.sort(), ['AbortSignal.timeout', 'captured setTimeout', 'named import', 'namespace import'])
})

test('not faked: performance.now', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const before = performance.now()
  t.mock.timers.tick(60_000)
  assert.ok(performance.now() - before < 60_000, 'a minute of ticks does not move it a minute')
})

test('timers separated by an await need tick, flush, tick', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const startChain = () => {
    const steps: string[] = []
    setTimeout(async () => {
      steps.push('first')
      await Promise.resolve()
      setTimeout(() => steps.push('second'), 50)
    }, 50)
    return steps
  }

  const unflushed = startChain()
  t.mock.timers.tick(50)
  t.mock.timers.tick(50)
  t.mock.timers.tick(50)
  assert.deepEqual(unflushed, ['first'], 'without a flush the second timer is never armed')

  const flushed = startChain()
  t.mock.timers.tick(50)
  await Promise.resolve()
  t.mock.timers.tick(50)
  assert.deepEqual(flushed, ['first', 'second'])
})
