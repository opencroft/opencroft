import { db, sshKey } from '@opencroft/db'
import type { HostSshKeysApi, SshKeyRecord } from '@opencroft/server'
import {
  derivePublicKey,
  inspectSshKey,
  type KeyStoreMaterial,
  privateKeyUnusableReason,
  removeCachedKeyStores,
  type SshKeyInfo,
} from '@opencroft/terminal/server'
import { and, asc, eq, inArray } from 'drizzle-orm'

import { decryptWith, deriveKey, encryptWith } from '@/server/crypto'

// ═══════════════════════════════════════════════════════════════════
// The Key Store nodes' keys, in the database.
//
// Rows are keyed by the store node's id and the key's name. The private half
// is encrypted with AES-256-GCM under OPENCROFT_KEYSTORE_SECRET, read from the
// environment on every use and never stored: the database is in every backup
// and dump, and a row is no more readable there than without the variable.
// Every instance that shares a database shares its keys, and needs the same
// value to read them.
// ═══════════════════════════════════════════════════════════════════

export const KEYSTORE_SECRET_ENV = 'OPENCROFT_KEYSTORE_SECRET'

// A salt of its own, so the passphrase of stored secrets, set to the same
// value by mistake, still derives a different key.
const SALT = '19ad8471330843089d27ac4f901b14c1'

/** Keys cannot be encrypted or decrypted: the variable is not set. Its message names no value. */
export class KeyStoreSecretMissingError extends Error {
  constructor() {
    super(
      `SSH keys in the key store cannot be read or stored: ${KEYSTORE_SECRET_ENV} is not set on this instance. ` +
        'Set it, to the same value on every instance that shares the database, and restart.',
    )
    this.name = 'KeyStoreSecretMissingError'
  }
}

/** A stored key the instance's OPENCROFT_KEYSTORE_SECRET does not decrypt. */
export class UndecryptableKeyError extends Error {
  constructor(storeId: string, name: string) {
    super(
      `SSH key ${name} (store: ${storeId}) could not be decrypted with this instance's ${KEYSTORE_SECRET_ENV}. ` +
        `It was stored under another value: set ${KEYSTORE_SECRET_ENV} to the one the instances sharing this database use, or rotate the key.`,
    )
    this.name = 'UndecryptableKeyError'
  }
}

/** Whether this instance can encrypt and decrypt keys. */
export function keyStoreSecretIsSet(): boolean {
  return Boolean(process.env[KEYSTORE_SECRET_ENV])
}

function cipherKey(): Buffer {
  const passphrase = process.env[KEYSTORE_SECRET_ENV]
  if (!passphrase) {
    throw new KeyStoreSecretMissingError()
  }
  return deriveKey(passphrase, SALT)
}

// The row's store and name are bound into its ciphertext, so a value copied
// into another row does not decrypt there.
function boundTo(storeId: string, name: string): string {
  return JSON.stringify([storeId, name])
}

function isPrivateKeyText(text: string): boolean {
  return text.includes('PRIVATE KEY') || text.includes('-----BEGIN')
}

// The PEM markers of a key under a passphrase: PKCS#8's own label, and the header of a
// traditional (PKCS#1, SEC1) key. Node cannot read such a key's type without the passphrase.
function isEncryptedPemKey(text: string): boolean {
  return /^-----BEGIN ENCRYPTED PRIVATE KEY-----\s*$/m.test(text) || /^Proc-Type:\s*4,ENCRYPTED\s*$/m.test(text)
}

type KeyColumns = Pick<typeof sshKey.$inferInsert, 'privateKeyEncrypted' | 'publicKey' | 'keyType' | 'fingerprint'>

/**
 * Refuses a key that is not an SSH private key, and one the SSH client cannot connect with
 * (`privateKeyUnusableReason`: a PKCS#8 key, or one with a passphrase), so a stored key does
 * not fail at its first connect. `info` is null for a PEM key under a passphrase, whose type
 * Node cannot read. A refusal never quotes the value.
 */
function requireUsableKey(name: string, privateKey: string, info: SshKeyInfo | null): void {
  if (!info && !isEncryptedPemKey(privateKey)) {
    throw new Error(`Key "${name}" is not an SSH private key`)
  }
  const reason = privateKeyUnusableReason(privateKey)
  if (reason === null) {
    return
  }
  // ssh-keygen (OpenSSH 9.6, 2026-10-28) rewrote every refused kind it was tried on: OpenSSH keys
  // with a passphrase, and RSA and EC keys in PKCS#8, PKCS#1 or SEC1, with a passphrase or without.
  // A PKCS#8 Ed25519 key, with a passphrase or without, is the exception: it answers "invalid format".
  const sshKeygen = '`ssh-keygen -p -f <key>` rewrites the key file in that format; leave the new passphrase empty.'
  const conversion = !info
    ? `For an RSA or ECDSA key, ${sshKeygen} For an Ed25519 key, which ssh-keygen cannot read in PKCS#8, ` +
      'convert it to OpenSSH format another way, or generate a new key in the store.'
    : info.type !== 'ED25519' || privateKey.includes('-----BEGIN OPENSSH PRIVATE KEY-----')
      ? sshKeygen
      : 'Convert the key to OpenSSH format, or generate a new key in the store.'
  throw new Error(
    `Key "${name}" cannot be used to connect (${reason}). Key Store takes a private key in OpenSSH format ` +
      `(-----BEGIN OPENSSH PRIVATE KEY-----) without a passphrase. ${conversion}`,
  )
}

/**
 * The columns that store `privateKey`. `strict` refuses a key `requireUsableKey` refuses;
 * otherwise its metadata is best effort, for a cache file, whose content nothing checks.
 */
function keyColumns(
  storeId: string,
  name: string,
  key: { privateKey: string; publicKey?: string },
  strict: boolean,
): KeyColumns {
  const info = isPrivateKeyText(key.privateKey) ? inspectSshKey(key.privateKey) : null
  if (strict) {
    requireUsableKey(name, key.privateKey, info)
  }
  let publicKey = key.publicKey?.trim() || null
  if (!publicKey && info) {
    try {
      publicKey = derivePublicKey(key.privateKey).trim()
    } catch {
      publicKey = null
    }
  }
  return {
    privateKeyEncrypted: encryptWith(cipherKey(), key.privateKey, boundTo(storeId, name)),
    publicKey,
    keyType: info?.type ?? 'unknown',
    fingerprint: info?.fingerprint ?? '',
  }
}

const recordColumns = {
  name: sshKey.name,
  type: sshKey.keyType,
  fingerprint: sshKey.fingerprint,
  publicKey: sshKey.publicKey,
}

function rowOf(storeId: string, name: string) {
  return and(eq(sshKey.storeId, storeId), eq(sshKey.name, name))
}

async function insertKey(storeId: string, name: string, columns: KeyColumns): Promise<boolean> {
  const inserted = await db
    .insert(sshKey)
    .values({ storeId, name, ...columns })
    .onConflictDoNothing({ target: [sshKey.storeId, sshKey.name] })
    .returning({ id: sshKey.id })
  return inserted.length > 0
}

export const sshKeys: HostSshKeysApi = {
  async list(storeId) {
    return db.select(recordColumns).from(sshKey).where(eq(sshKey.storeId, storeId)).orderBy(asc(sshKey.name))
  },

  async get(storeId, name) {
    const [row] = await db.select(recordColumns).from(sshKey).where(rowOf(storeId, name))
    return (row as SshKeyRecord | undefined) ?? null
  },

  async put(storeId, name, key, mode) {
    const columns = keyColumns(storeId, name, key, true)
    if (mode === 'create') {
      return insertKey(storeId, name, columns)
    }
    const replaced = await db.update(sshKey).set(columns).where(rowOf(storeId, name)).returning({ id: sshKey.id })
    return replaced.length > 0
  },

  async delete(storeId, name) {
    const deleted = await db.delete(sshKey).where(rowOf(storeId, name)).returning({ id: sshKey.id })
    return deleted.length > 0
  },
}

/** A store that holds keys, with their names. */
export interface KeyStoreHolding {
  storeId: string
  keys: string[]
}

/** The stores among `storeIds` that hold keys, in name order within each. Decrypts nothing. */
export async function keyStoresHolding(storeIds: string[]): Promise<KeyStoreHolding[]> {
  if (storeIds.length === 0) {
    return []
  }
  const rows = await db
    .select({ storeId: sshKey.storeId, name: sshKey.name })
    .from(sshKey)
    .where(inArray(sshKey.storeId, storeIds))
    .orderBy(asc(sshKey.storeId), asc(sshKey.name))
  const byStore = new Map<string, string[]>()
  for (const row of rows) {
    byStore.set(row.storeId, [...(byStore.get(row.storeId) ?? []), row.name])
  }
  return [...byStore].map(([storeId, keys]) => ({ storeId, keys }))
}

/**
 * Deletes every key of the stores `storeIds`; an id that holds none is passed over. Their cache
 * files go first, as a single key's do: a start copies them into the database, so files left
 * after the rows would bring the keys back.
 */
export async function deleteKeyStores(storeIds: string[]): Promise<void> {
  if (storeIds.length === 0) {
    return
  }
  await removeCachedKeyStores(storeIds)
  await db.delete(sshKey).where(inArray(sshKey.storeId, storeIds))
}

/** What the terminal package reads store keys from (see `registerKeyStoreMaterial`). */
export const sshKeyMaterial: KeyStoreMaterial = {
  async read(storeId, name) {
    const [row] = await db
      .select({ privateKeyEncrypted: sshKey.privateKeyEncrypted })
      .from(sshKey)
      .where(rowOf(storeId, name))
    if (!row) {
      return null
    }
    const key = cipherKey()
    try {
      return decryptWith(key, row.privateKeyEncrypted, boundTo(storeId, name))
    } catch {
      // GCM's own failure says only "unable to authenticate data".
      throw new UndecryptableKeyError(storeId, name)
    }
  },

  backfill(storeId, name, privateKey) {
    return insertKey(storeId, name, keyColumns(storeId, name, { privateKey }, false))
  },
}
