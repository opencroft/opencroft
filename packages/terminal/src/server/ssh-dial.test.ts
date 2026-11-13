import assert from 'node:assert/strict'
import test from 'node:test'

import { registerKeyStoreAccess } from './keys'
import { exec } from './ssh'

test('a failed dial rejects its caller and leaves no rejection unhandled', async () => {
  // The dial names a Key Store key, so it fails at the access rule, before any network.
  registerKeyStoreAccess(async (storeId) => {
    throw new Error(`refused: ${storeId}`)
  })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    await assert.rejects(
      () => exec({ host: '127.0.0.1', port: 1, username: 'someone', keyPath: 'store-1:deploy' }, 'true'),
      /refused: store-1/,
    )
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }

  assert.deepEqual(unhandled, [])
})
