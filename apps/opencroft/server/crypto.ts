import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

import { instanceKeyFile, readInstanceKey } from '@opencroft/instance'

const ALG = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const SALT = '2ccdf726dee761841491bd1dd5011190'

/**
 * The fallback passphrase for secrets stored while no secrets key was set,
 * by builds that did not generate one. It is published in this
 * repository, so it protects nothing. It is kept only so the startup check can
 * recognise secrets stored under it (see instance-keys.ts).
 */
export const LEGACY_DEFAULT_SECRETS_KEY = 'homelab-default-key'

/** A stored value that the instance's OPENCROFT_SECRETS_KEY does not decrypt. Its message names no value. */
export class UndecryptableSecretError extends Error {
  constructor() {
    const source = readInstanceKey('OPENCROFT_SECRETS_KEY')?.source === 'env' ? 'the environment' : instanceKeyFile()
    super(
      `A stored secret could not be decrypted with this instance's OPENCROFT_SECRETS_KEY (from ${source}). ` +
        'It was encrypted under another key: on another instance, or before OPENCROFT_SECRETS_KEY changed. ' +
        'Set OPENCROFT_SECRETS_KEY to the key it was stored under and restart, or store the secret again.',
    )
    this.name = 'UndecryptableSecretError'
  }
}

// Derived keys by passphrase: scrypt is slow on purpose, and the passphrase is
// the same on every call while the server runs.
const derivedKeys = new Map<string, Buffer>()

function deriveKey(passphrase: string): Buffer {
  let key = derivedKeys.get(passphrase)
  if (!key) {
    key = scryptSync(passphrase, SALT, 32)
    derivedKeys.set(passphrase, key)
  }
  return key
}

// Reads, never creates. The server creates the secrets key at startup, after
// checking whether stored secrets still need the legacy key; a key made here
// would skip that check and could leave every stored secret unreadable.
function currentKey(): Buffer {
  const passphrase = readInstanceKey('OPENCROFT_SECRETS_KEY')
  if (!passphrase) {
    throw new Error(
      `OPENCROFT_SECRETS_KEY is not set and ${instanceKeyFile()} has none yet. The server creates it when it starts; ` +
        'nothing can be encrypted or decrypted before that.',
    )
  }
  return deriveKey(passphrase.value)
}

export function encrypt(plaintext: string): string {
  const key = currentKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

function decryptWith(key: Buffer, encoded: string): string {
  const buf = Buffer.from(encoded, 'base64')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const encrypted = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALG, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

/** Decrypt a value `encrypt` produced. Throws {@link UndecryptableSecretError} when another key produced it. */
export function decrypt(encoded: string): string {
  const key = currentKey()
  try {
    return decryptWith(key, encoded)
  } catch {
    // GCM's own failure says only "unable to authenticate data", which reads
    // as a bug rather than as a key that does not match.
    throw new UndecryptableSecretError()
  }
}

/** Whether `encoded` decrypts under `passphrase`, or under the instance's SECRETS_KEY when none is given. */
export function canDecrypt(encoded: string, passphrase?: string): boolean {
  try {
    decryptWith(passphrase === undefined ? currentKey() : deriveKey(passphrase), encoded)
    return true
  } catch {
    return false
  }
}
