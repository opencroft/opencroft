import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import ssh2 from 'ssh2'

import { privateKeyUnusableReason } from './ssh'
import { generateSshKey, type SshKeyType } from './ssh-key-format'

test('a key Key Store generates is usable, of every type', () => {
  for (const keyType of ['ed25519', 'rsa', 'ecdsa'] satisfies SshKeyType[]) {
    assert.equal(privateKeyUnusableReason(generateSshKey(keyType, 'probe').privateKey), null, keyType)
  }
})

test('a PKCS#8 Ed25519 key is unusable, with the reason ssh2 gives', () => {
  const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  assert.equal(privateKeyUnusableReason(privateKey), 'Unsupported key format')
})

test('an OpenSSH key with a passphrase is unusable: a dial sends none', () => {
  const { private: privateKey } = ssh2.utils.generateKeyPairSync('ed25519', {
    passphrase: 'pass',
    cipher: 'aes256-ctr',
    rounds: 16,
  })

  assert.match(privateKeyUnusableReason(privateKey) ?? '', /no passphrase given/)
})
