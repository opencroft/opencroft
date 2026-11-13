// `credentialRedactor`, as an extension gets it from `@opencroft/server/secrets`, over the real
// Secrets Store (embedded PGlite). The text rules themselves are pinned in redact-text.test.ts.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, secret } from '@opencroft/db'

import { credentialRedactor } from './credential-redactor'
import { secrets } from './secrets'

// Fixture values are placeholders; no real credential is used here.

test('hides a stored value, also inside base64, and a value the caller passes', async () => {
  const storeId = `redactor-test-${crypto.randomUUID()}`
  const stored = `stored-${crypto.randomUUID()}`
  await secrets.set(storeId, 'TOKEN', stored)
  try {
    const redactor = await credentialRedactor({ values: ['caller-known-pw'] })
    const encoded = Buffer.from(`alice:${stored}`).toString('base64')
    assert.equal(
      redactor.redact(`token=${stored} auth=${encoded} pw=caller-known-pw host=db.example.com`),
      'token=[redacted] auth=[redacted] pw=[redacted] host=db.example.com',
    )
  } finally {
    await secrets.delete(storeId, 'TOKEN')
  }
})

test('leaves a value shorter than its floor in the text', async () => {
  const redactor = await credentialRedactor({ values: ['root', 'x'.repeat(5)] })
  assert.equal(redactor.minValueLength, 6)
  assert.equal(redactor.redact('user root xxxxx'), 'user root xxxxx')
})

test('streams with the same rules as whole text', async () => {
  const redactor = await credentialRedactor({ values: ['caller-known-pw'] })
  const stream = redactor.stream()
  assert.equal(stream.push('pw=caller-kn'), '')
  assert.equal(stream.push('own-pw\nnext'), 'pw=[redacted]\n')
  assert.equal(stream.flush(), 'next')
})

test('a stored row the instance cannot decrypt does not stop it', async () => {
  const storeId = `redactor-test-${crypto.randomUUID()}`
  const stored = `stored-${crypto.randomUUID()}`
  await secrets.set(storeId, 'READABLE', stored)
  await db.insert(secret).values({ storeId, key: 'UNREADABLE', value: 'not-ciphertext' })
  try {
    await assert.rejects(() => secrets.listAll(), 'the control: decrypting every row fails on the unreadable one')
    const redactor = await credentialRedactor()
    assert.equal(redactor.redact(`token=${stored}`), 'token=[redacted]')
  } finally {
    await secrets.delete(storeId, 'UNREADABLE')
    await secrets.delete(storeId, 'READABLE')
  }
})
