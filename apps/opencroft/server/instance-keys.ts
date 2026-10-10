// The instance keys as the server prepares and reports them. Where the values
// come from, and the file itself, are @opencroft/instance's.

import { db } from '@opencroft/db'
import {
  ensureInstanceKey,
  type InstanceKeyName,
  type InstanceKeySource,
  instanceKeyFile,
  instanceKeySources,
  keyFileNotice,
  readInstanceKey,
} from '@opencroft/instance'

import { canDecrypt, LEGACY_DEFAULT_SECRETS_KEY } from '@/server/crypto'

// One instance encrypts every secret under one key, so any row settles which
// key that is; a few rows rather than one only so a single damaged value
// cannot decide it.
const UPGRADE_SAMPLE = 20

/**
 * Make sure both keys exist before anything signs a session or touches a stored
 * secret, and tell the log where they come from. Runs on every start.
 *
 * A key with no environment variable and no entry in the key file is created
 * here. For the secrets key that is also the upgrade path: an instance that ran
 * before keys were generated encrypted its secrets under the published default,
 * and if stored secrets decrypt under it, that default is what goes into the
 * file, so they stay readable. Re-encrypting them under a new key instead
 * would break any other instance that shares this database but not this data
 * volume, and could not reach values extensions encrypted through the host API
 * and keep in their own storage.
 */
export async function prepareInstanceKeys(): Promise<void> {
  if (!readInstanceKey('OPENCROFT_SECRETS_KEY')) {
    const legacy = await storedSecretsUseLegacyKey()
    ensureInstanceKey('OPENCROFT_SECRETS_KEY', legacy ? () => LEGACY_DEFAULT_SECRETS_KEY : undefined)
  }
  ensureInstanceKey('OPENCROFT_AUTH_SECRET')

  const notice = instanceKeysStatus().notice
  if (notice) {
    console.warn(`[instance-keys] ${notice}`)
  }
  if (readInstanceKey('OPENCROFT_SECRETS_KEY')?.value === LEGACY_DEFAULT_SECRETS_KEY) {
    console.warn(
      '[instance-keys] Stored secrets are encrypted under the former built-in secrets key, which is published ' +
        'in the OpenCroft source, so it does not protect them. It is kept so they stay readable. To protect them, ' +
        'set a new OPENCROFT_SECRETS_KEY and store each secret again.',
    )
  }
}

async function storedSecretsUseLegacyKey(): Promise<boolean> {
  const rows = await db.query.secret.findMany({ columns: { value: true }, limit: UPGRADE_SAMPLE })
  return rows.some((row) => canDecrypt(row.value, LEGACY_DEFAULT_SECRETS_KEY))
}

export interface InstanceKeysStatus {
  /** Where each key comes from; null only before the server has prepared it. */
  sources: Record<InstanceKeyName, InstanceKeySource | null>
  keyFile: string
  /** The warning to show while any key comes from the key file, else null. */
  notice: string | null
}

export function instanceKeysStatus(): InstanceKeysStatus {
  const sources = instanceKeySources()
  const keyFile = instanceKeyFile()
  const fromFile = Object.values(sources).includes('file')
  return { sources, keyFile, notice: fromFile ? keyFileNotice(keyFile) : null }
}
