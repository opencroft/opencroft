import assert from 'node:assert/strict'
import test from 'node:test'

import { generateSshKey } from '@opencroft/terminal/server'

import { serialize } from './audit'

test('a private key in a call’s arguments is redacted, and the rest of the call is kept', () => {
  const key = generateSshKey('ed25519', 'deploy')
  const text = serialize({
    nodeId: 'store-1',
    action: 'import',
    params: { name: 'deploy', privateKey: key.privateKey },
  })

  assert.doesNotMatch(text, /PRIVATE KEY|BEGIN/)
  assert.ok(!text.includes(key.privateKey.split('\n')[1]))
  assert.deepEqual(JSON.parse(text), {
    nodeId: 'store-1',
    action: 'import',
    params: { name: 'deploy', privateKey: '[private key redacted]' },
  })
})

test('a PEM private key inside other text is redacted to the end of that string', () => {
  const text = serialize({
    content: 'head\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\n',
    other: 'kept',
  })

  assert.deepEqual(JSON.parse(text), { content: 'head\n[private key redacted]', other: 'kept' })
})

test('a public key and ordinary text pass through unchanged', () => {
  const value = { publicKey: generateSshKey('ed25519').publicKey, note: 'BEGIN here' }

  assert.deepEqual(JSON.parse(serialize(value)), value)
})
