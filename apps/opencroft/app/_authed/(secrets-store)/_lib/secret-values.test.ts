import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isTypedCredential,
  readNamedValues,
  readSecretValue,
  storeNamedValues,
  storeSecretValue,
  typedCredentialSentence,
  typedCredentialWarning,
} from './secret-values'

// Fixture values are placeholders; no real credential is used here.

test('reads a secret: value as the secret it names, and anything else as typed', () => {
  assert.deepEqual(readSecretValue('secret:SPEECH_KEY'), { secret: 'SPEECH_KEY' })
  assert.deepEqual(readSecretValue('placeholder'), { value: 'placeholder' })
  assert.deepEqual(readSecretValue(undefined), { value: '' })
})

test('trims a secret name the way the server resolves it', () => {
  assert.deepEqual(readSecretValue('secret:  SPEECH_KEY  '), { secret: 'SPEECH_KEY' })
})

test('stores a secret by name only, and typed text as typed', () => {
  assert.equal(storeSecretValue({ secret: 'SPEECH_KEY' }), 'secret:SPEECH_KEY')
  assert.equal(storeSecretValue({ value: 'placeholder' }), 'placeholder')
})

test('reads stored pairs as rows, a secret: value as the secret it names', () => {
  assert.deepEqual(
    readNamedValues([
      { name: 'Authorization', value: 'secret:SPEECH_KEY' },
      { name: 'X-Request-Source', value: 'opencroft' },
    ]),
    [
      { name: 'Authorization', secret: 'SPEECH_KEY' },
      { name: 'X-Request-Source', value: 'opencroft' },
    ],
  )
})

test('leaves out a row with no name, and an entry that is not a pair of strings', () => {
  const stored = [
    { name: '', value: 'x' },
    { name: '  ', value: 'y' },
    { name: 'X-Ok', value: 'z' },
    null,
    { name: 3, value: 'w' },
  ] as unknown as Parameters<typeof readNamedValues>[0]
  assert.deepEqual(readNamedValues(stored), [{ name: 'X-Ok', value: 'z' }])
  assert.deepEqual(readNamedValues(undefined), [])
})

test('rows read back as what they were stored as', () => {
  const stored = [
    { name: 'Authorization', value: 'secret:SPEECH_KEY' },
    { name: 'Accept', value: 'audio/pcm' },
  ]
  assert.deepEqual(storeNamedValues(readNamedValues(stored)), stored)
})

test('flags a typed value under a credential-shaped name', () => {
  for (const name of ['Authorization', 'proxy-authorization', 'X-API-Key', 'api_key', 'X-Auth-Token', 'Cookie']) {
    assert.equal(isTypedCredential(name, 'placeholder'), true, name)
  }
})

test('flags a credential scheme whatever the name is', () => {
  assert.equal(isTypedCredential('X-Upstream', 'Bearer placeholder'), true)
  assert.equal(isTypedCredential('X-Upstream', 'basic cGxhY2Vob2xkZXI='), true)
  // A reference inside a scheme is not a reference: the server sends it as typed.
  assert.equal(isTypedCredential('X-Upstream', 'Bearer secret:SPEECH_KEY'), true)
})

test('does not flag a secret reference, an empty value, or an ordinary pair', () => {
  assert.equal(isTypedCredential('Authorization', 'secret:SPEECH_KEY'), false)
  assert.equal(isTypedCredential('Authorization', '   '), false)
  assert.equal(isTypedCredential('Accept', 'audio/pcm'), false)
  assert.equal(isTypedCredential('X-Request-Source', 'opencroft'), false)
})

test('the warning names the row and never repeats the value', () => {
  const warning = typedCredentialWarning({ name: 'Authorization', value: 'Bearer placeholder-value' })
  assert.ok(warning?.startsWith('Authorization '))
  assert.ok(!warning?.includes('placeholder-value'))
  assert.equal(typedCredentialWarning({ name: 'Accept', value: 'audio/pcm' }), undefined)
})

test('the warning names what holds the value: the node by default, or the App settings', () => {
  assert.match(typedCredentialSentence('Password'), /typed into the node, so anyone who reads the node reads it/)
  assert.match(
    typedCredentialSentence('Password', 'app'),
    /typed into the App's settings, so anyone who reads the App's settings reads it/,
  )
  assert.match(
    typedCredentialWarning({ name: 'Authorization', value: 'Bearer placeholder-value' }, 'app') ?? '',
    /the App's settings/,
  )
})
