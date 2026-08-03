import host from '@opencroft/server'

// ═══════════════════════════════════════════════════════════════════
// Secrets Store — generate/rotate
//
// Server-side only: the generated value is written straight into the store
// and never appears in this module's return value, so it can't leak into a
// UI toast, an MCP tool result, or an agent's context.
// ═══════════════════════════════════════════════════════════════════

const ALPHANUMERIC_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
// Adds a conservative symbol set on top of alphanumeric — avoids characters
// that commonly need escaping (quotes, backticks, `$`, shell/URL metacharacters)
// since the value's only sanctioned path out is subprocess env injection.
const SYMBOLS_CHARSET = `${ALPHANUMERIC_CHARSET}!@#%^&*_+-=`

const DEFAULT_LENGTH = 32
const MIN_LENGTH = 8
const MAX_LENGTH = 256

export type SecretFormat = 'alphanumeric' | 'symbols'

export interface GenerateSecretOptions {
  length?: number
  format?: SecretFormat
}

export interface GenerateSecretResult {
  name: string
  status: 'created' | 'rotated'
}

export async function secretsStoreGenerate(
  storeId: string,
  name: string,
  options?: GenerateSecretOptions,
): Promise<GenerateSecretResult> {
  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new Error('Secret name is required')
  }
  const length = options?.length ?? DEFAULT_LENGTH
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    throw new Error(`length must be an integer between ${MIN_LENGTH} and ${MAX_LENGTH}`)
  }
  const charset = options?.format === 'symbols' ? SYMBOLS_CHARSET : ALPHANUMERIC_CHARSET

  const existing = await host.secrets.get(storeId, trimmedName)
  const status: GenerateSecretResult['status'] = existing === null ? 'created' : 'rotated'

  const value = host.crypto.randomString(length, charset)
  await host.secrets.set(storeId, trimmedName, value)

  return { name: trimmedName, status }
}
