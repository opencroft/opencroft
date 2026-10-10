// A provider point's extensions are loaded when the point is first used, not
// with every other point's. These mount real consumers against a real DOM,
// because what they pin is which loads a mounted consumer starts.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// After the DOM exists, never before — react-dom binds to the globals it finds.
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { providerRegistry, useProvided } = await import('@/app/_authed/(extension-runtime)/_client/provides')

after(() => dom.cleanup())

const asked: string[] = []
const pending = new Map<string, () => void>()

// Records the point it is asked for, and finishes only when the test says so.
function loadProviders(point: string): Promise<void> {
  asked.push(point)
  return new Promise((resolve) => pending.set(point, resolve))
}

const seen = new Map<string, { items: unknown[]; loaded: boolean }>()

function Consumer({ point }: { point: string }) {
  seen.set(point, useProvided(point, loadProviders))
  return null
}

async function mount(...points: string[]): Promise<void> {
  const root = createRoot(dom.container.appendChild(document.createElement('div')))
  after(() => {
    act(() => root.unmount())
  })
  await act(async () => {
    root.render(points.map((point) => <Consumer key={point} point={point} />))
  })
}

test('a mounted consumer loads its own point, and only that one', async () => {
  await mount('point-a')

  assert.deepEqual(asked, ['point-a'])
  assert.equal(seen.get('point-a')?.loaded, false)
})

test('a second consumer of the same point does not load it again', async () => {
  await mount('point-a')

  assert.deepEqual(asked, ['point-a'])
})

test('another point is loaded when its consumer mounts, and is loaded on its own', async () => {
  await mount('point-b')
  assert.deepEqual(asked, ['point-a', 'point-b'])

  await act(async () => {
    pending.get('point-b')?.()
  })

  assert.equal(seen.get('point-b')?.loaded, true)
  assert.equal(seen.get('point-a')?.loaded, false, 'point-a is still on its way')
})

test('entries are listed in the listing order, whichever extension registered first', async () => {
  providerRegistry.setOrder(['ext.first', 'ext.second'])
  providerRegistry.register('ext.second', { 'order-point': ['from-second'] })
  providerRegistry.register('ext.first', { 'order-point': ['from-first'] })

  assert.deepEqual(providerRegistry.get('order-point'), ['from-first', 'from-second'])
})

test('an extension the listing does not name follows the listed ones', async () => {
  providerRegistry.setOrder(['ext.listed'])
  providerRegistry.register('ext.unlisted', { 'tail-point': ['unlisted'] })
  providerRegistry.register('ext.listed', { 'tail-point': ['listed'] })

  assert.deepEqual(providerRegistry.get('tail-point'), ['listed', 'unlisted'])
})
