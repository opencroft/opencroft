import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const IDENTITY_PATH = path.join(process.cwd(), 'data', 'openclaw', 'device.json')
const TOKEN_PATH = path.join(process.cwd(), 'data', 'openclaw', 'device-token.json')
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export interface DeviceIdentity {
  deviceId: string
  publicKeyPem: string
  privateKeyPem: string
}

interface StoredIdentity extends DeviceIdentity {
  version: 1
  createdAtMs: number
}

export interface StoredDeviceToken {
  deviceToken: string
  role: string
  scopes: string[]
  savedAtMs: number
}

interface AuthPayloadParams {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: string[]
  signedAtMs: number
  token: string | null
  nonce: string
  platform?: string
  deviceFamily?: string
}

export function loadOrCreateIdentity(): DeviceIdentity {
  const existing = readIdentity()
  if (existing) {
    return existing
  }
  return createIdentity()
}

function readIdentity(): DeviceIdentity | null {
  if (!fs.existsSync(IDENTITY_PATH)) {
    return null
  }
  const parsed = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8')) as Partial<StoredIdentity>
  if (parsed.version !== 1 || !parsed.deviceId || !parsed.publicKeyPem || !parsed.privateKeyPem) {
    return null
  }
  return {
    deviceId: parsed.deviceId,
    publicKeyPem: parsed.publicKeyPem,
    privateKeyPem: parsed.privateKeyPem,
  }
}

function createIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const deviceId = fingerprint(publicKeyPem)
  const stored: StoredIdentity = {
    version: 1,
    deviceId,
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now(),
  }
  fs.mkdirSync(path.dirname(IDENTITY_PATH), { recursive: true })
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify(stored, null, 2), { mode: 0o600 })
  return { deviceId, publicKeyPem, privateKeyPem }
}

export function publicKeyBase64Url(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem))
}

export function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem)
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key))
}

export function buildDeviceAuthPayloadV3(params: AuthPayloadParams): string {
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
    params.nonce,
    normalizeMeta(params.platform),
    normalizeMeta(params.deviceFamily),
  ].join('|')
}

export function loadDeviceToken(): StoredDeviceToken | null {
  if (!fs.existsSync(TOKEN_PATH)) {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) as StoredDeviceToken
  } catch {
    return null
  }
}

export function saveDeviceToken(token: StoredDeviceToken): void {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true })
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 })
}

export function clearDeviceToken(): void {
  if (fs.existsSync(TOKEN_PATH)) {
    fs.unlinkSync(TOKEN_PATH)
  }
}

function normalizeMeta(value: string | undefined): string {
  if (!value) {
    return ''
  }
  return value.trim().toLowerCase()
}

function fingerprint(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem)
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({
    type: 'spki',
    format: 'der',
  })
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length)
  }
  return spki
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}
