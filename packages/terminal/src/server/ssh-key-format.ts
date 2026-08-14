import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'

// ═══════════════════════════════════════════════════════════════════
// SSH key generation and inspection, in pure Node.
//
// This exists because shelling out to `ssh-keygen` made key creation
// depend on openssh-client being installed on the host, which it is not
// in the runtime image — the key store simply refused to create keys.
// Nothing here spawns a process or needs a native module.
//
// The formats are OpenSSH's, not Node's, and that is the whole
// difficulty: Node speaks PEM/DER/JWK, while an SSH key on disk is a
// private half in `openssh-key-v1` armor and a public half in one
// authorized_keys line. Both are written by hand below.
// ═══════════════════════════════════════════════════════════════════

export type SshKeyType = 'ed25519' | 'rsa' | 'ecdsa'

export interface GeneratedSshKey {
  /** openssh-key-v1 armor, written to the key file with mode 600. */
  privateKey: string
  /** One authorized_keys line, written to `<key>.pub`. */
  publicKey: string
  fingerprint: string
  bits: number
  /** Uppercase, as `ssh-keygen -l` prints it in parentheses. */
  type: string
}

export interface SshKeyInfo {
  fingerprint: string
  bits: number
  type: string
}

// ── SSH wire encoding ──────────────────────────────────────────────
//
// Everything in both formats is built from two primitives: a
// length-prefixed byte string, and an integer that is a length-prefixed
// byte string with a rule about its sign bit.

function sshString(value: Buffer | string): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  return Buffer.concat([length, body])
}

function sshUint32(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value, 0)
  return buf
}

/**
 * An SSH mpint is two's-complement, so a value whose top bit is set needs
 * a leading zero byte or it reads as negative. Leading zeros are stripped
 * first because JWK and DER disagree about padding, and a modulus that
 * arrives with one would otherwise hash to a different fingerprint than
 * the same key from ssh-keygen.
 */
function sshMpint(value: Buffer): Buffer {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) {
    start += 1
  }
  const trimmed = value.subarray(start)
  const needsPad = (trimmed[0] ?? 0) & 0x80
  return sshString(needsPad ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

// A JWK coordinate is minimal-length, but an EC point wants every
// coordinate at the curve's full width — so left-pad rather than trust it.
function padTo(value: Buffer, size: number): Buffer {
  return value.length >= size ? value : Buffer.concat([Buffer.alloc(size - value.length), value])
}

// ── Public key blobs ───────────────────────────────────────────────

const ECDSA_CURVE = 'nistp256'
const ECDSA_ALGORITHM = `ecdsa-sha2-${ECDSA_CURVE}`

interface KeyMaterial {
  algorithm: string
  publicBlob: Buffer
  /** The private half, already in the layout openssh-key-v1 expects. */
  privateFields: Buffer
  bits: number
  type: string
}

// JWK rather than DER offsets: the same call shape works for all three
// key types, and it does not assume where a field sits inside an encoding
// that is free to move it.
function materialFromKeyPair(publicKey: KeyObject, privateKey: KeyObject, keyType: SshKeyType): KeyMaterial {
  const priv = privateKey.export({ format: 'jwk' }) as Record<string, string>
  const pub = publicKey.export({ format: 'jwk' }) as Record<string, string>

  if (keyType === 'ed25519') {
    const publicRaw = fromBase64Url(pub.x)
    const seed = fromBase64Url(priv.d)
    const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(publicRaw)])
    return {
      algorithm: 'ssh-ed25519',
      publicBlob,
      // The private field is seed||public, not the seed alone — OpenSSH
      // stores the 64-byte expanded form.
      privateFields: Buffer.concat([
        sshString('ssh-ed25519'),
        sshString(publicRaw),
        sshString(Buffer.concat([seed, publicRaw])),
      ]),
      bits: 256,
      type: 'ED25519',
    }
  }

  if (keyType === 'rsa') {
    const n = fromBase64Url(pub.n)
    const e = fromBase64Url(pub.e)
    const publicBlob = Buffer.concat([sshString('ssh-rsa'), sshMpint(e), sshMpint(n)])
    return {
      algorithm: 'ssh-rsa',
      publicBlob,
      // Field order is OpenSSH's own and differs from every other RSA
      // encoding: n, e, d, iqmp, p, q. JWK's `qi` IS iqmp (q⁻¹ mod p).
      privateFields: Buffer.concat([
        sshString('ssh-rsa'),
        sshMpint(n),
        sshMpint(e),
        sshMpint(fromBase64Url(priv.d)),
        sshMpint(fromBase64Url(priv.qi)),
        sshMpint(fromBase64Url(priv.p)),
        sshMpint(fromBase64Url(priv.q)),
      ]),
      bits: n.length * 8,
      type: 'RSA',
    }
  }

  const x = padTo(fromBase64Url(pub.x), 32)
  const y = padTo(fromBase64Url(pub.y), 32)
  // Uncompressed point: 0x04 marker, then both coordinates at full width.
  const point = Buffer.concat([Buffer.from([0x04]), x, y])
  const publicBlob = Buffer.concat([sshString(ECDSA_ALGORITHM), sshString(ECDSA_CURVE), sshString(point)])
  return {
    algorithm: ECDSA_ALGORITHM,
    publicBlob,
    privateFields: Buffer.concat([
      sshString(ECDSA_ALGORITHM),
      sshString(ECDSA_CURVE),
      sshString(point),
      sshMpint(fromBase64Url(priv.d)),
    ]),
    bits: 256,
    type: 'ECDSA',
  }
}

// ── openssh-key-v1 ─────────────────────────────────────────────────

const AUTH_MAGIC = Buffer.from('openssh-key-v1\0', 'binary')
// The 'none' cipher still has a block size, and the private section is
// padded to it.
const NONE_CIPHER_BLOCK = 8

function armorPrivateKey(body: Buffer): string {
  const base64 = body.toString('base64')
  const lines = base64.match(/.{1,70}/g) ?? []
  return ['-----BEGIN OPENSSH PRIVATE KEY-----', ...lines, '-----END OPENSSH PRIVATE KEY-----', ''].join('\n')
}

function encodeOpenSshPrivateKey(material: KeyMaterial, comment: string): string {
  // Two copies of the same number. On decrypt they must match, which is
  // how OpenSSH detects a wrong passphrase; unencrypted, any value works
  // as long as it is written twice.
  const checkint = Buffer.alloc(4)
  checkint.writeUInt32BE(Math.floor(Math.random() * 0xffffffff), 0)

  let section = Buffer.concat([checkint, checkint, material.privateFields, sshString(comment)])
  // Pad with 1,2,3… — the sequence is part of the format, not filler.
  const padding: number[] = []
  while ((section.length + padding.length) % NONE_CIPHER_BLOCK !== 0) {
    padding.push(padding.length + 1)
  }
  section = Buffer.concat([section, Buffer.from(padding)])

  return armorPrivateKey(
    Buffer.concat([
      AUTH_MAGIC,
      sshString('none'), // cipher
      sshString('none'), // kdf
      sshString(''), // kdf options
      sshUint32(1), // key count
      sshString(material.publicBlob),
      sshString(section),
    ]),
  )
}

/** Read the fields of an openssh-key-v1 file. */
function parseOpenSshPrivateKey(text: string): { algorithm: string; publicBlob: Buffer; comment: string } | null {
  const match = text.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/)
  if (!match) {
    return null
  }
  const body = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
  if (!body.subarray(0, AUTH_MAGIC.length).equals(AUTH_MAGIC)) {
    return null
  }
  let offset = AUTH_MAGIC.length
  const readString = (): Buffer => {
    const length = body.readUInt32BE(offset)
    offset += 4
    const value = body.subarray(offset, offset + length)
    offset += length
    return value
  }
  const cipher = readString().toString('utf8')
  readString() // kdf name
  readString() // kdf options
  offset += 4 // key count
  const publicBlob = readString()
  const algorithmLength = publicBlob.readUInt32BE(0)
  const algorithm = publicBlob.subarray(4, 4 + algorithmLength).toString('utf8')

  // The comment lives inside the private section, so it is only readable
  // when that section is not encrypted. An encrypted key still exposes its
  // public half in clear -- which is what this is mainly after -- so a
  // passphrase costs the comment, not the answer.
  let comment = ''
  if (cipher === 'none') {
    try {
      const section = readString()
      let at = 8 // two checkints
      const skip = () => {
        const length = section.readUInt32BE(at)
        at += 4 + length
      }
      // The private fields, then the comment. Their count varies by type,
      // so walk to the last string before the 1,2,3… padding rather than
      // hard-coding a field count per algorithm.
      let lastString = ''
      while (at + 4 <= section.length) {
        const length = section.readUInt32BE(at)
        if (at + 4 + length > section.length) {
          break
        }
        lastString = section.subarray(at + 4, at + 4 + length).toString('utf8')
        skip()
      }
      comment = lastString
    } catch {
      /* comment is a nicety; the public half is the point */
    }
  }
  return { algorithm, publicBlob, comment }
}

// ── Public API ─────────────────────────────────────────────────────

function describe(algorithm: string, publicBlob: Buffer): SshKeyInfo {
  // OpenSSH hashes the blob itself, and prints base64 with the padding
  // stripped.
  const fingerprint = `SHA256:${createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`
  if (algorithm === 'ssh-ed25519') {
    return { fingerprint, bits: 256, type: 'ED25519' }
  }
  if (algorithm.startsWith('ecdsa-sha2-')) {
    const curve = algorithm.slice('ecdsa-sha2-nistp'.length)
    return { fingerprint, bits: Number.parseInt(curve, 10) || 256, type: 'ECDSA' }
  }
  if (algorithm === 'ssh-rsa') {
    // Skip algorithm and exponent to reach the modulus, whose length is
    // the key size. Its leading zero, if the mpint needed one, is not.
    let offset = 4 + algorithm.length
    const eLength = publicBlob.readUInt32BE(offset)
    offset += 4 + eLength
    const nLength = publicBlob.readUInt32BE(offset)
    const n = publicBlob.subarray(offset + 4, offset + 4 + nLength)
    return { fingerprint, bits: (n[0] === 0 ? n.length - 1 : n.length) * 8, type: 'RSA' }
  }
  return { fingerprint, bits: 0, type: algorithm.toUpperCase() }
}

/** Generate a key pair in the on-disk formats OpenSSH reads. */
export function generateSshKey(keyType: SshKeyType, comment = ''): GeneratedSshKey {
  const { publicKey, privateKey } =
    keyType === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : keyType === 'rsa'
        ? // ssh-keygen's own default since OpenSSH 7.8.
          generateKeyPairSync('rsa', { modulusLength: 3072 })
        : generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

  const material = materialFromKeyPair(publicKey, privateKey, keyType)
  const info = describe(material.algorithm, material.publicBlob)
  const publicLine = [material.algorithm, material.publicBlob.toString('base64'), comment].filter(Boolean).join(' ')
  return {
    privateKey: encodeOpenSshPrivateKey(material, comment),
    publicKey: `${publicLine}\n`,
    fingerprint: info.fingerprint,
    bits: info.bits,
    type: info.type,
  }
}

/**
 * The authorized_keys line for a private key — the replacement for
 * `ssh-keygen -y`.
 *
 * An openssh-key-v1 file carries its own public half, so that case is a
 * read rather than a derivation, and it works even for a passphrase-
 * protected key. Anything else is a PEM Node can parse (an imported
 * PKCS#8, PKCS#1 or SEC1 key), and is derived.
 */
export function derivePublicKey(privateKeyText: string, comment = ''): string {
  const parsed = parseOpenSshPrivateKey(privateKeyText)
  if (parsed) {
    const label = comment || parsed.comment
    return `${[parsed.algorithm, parsed.publicBlob.toString('base64'), label].filter(Boolean).join(' ')}\n`
  }
  const privateKey = createPrivateKey(privateKeyText)
  const publicKey = createPublicKey(privateKey)
  const keyType: SshKeyType =
    privateKey.asymmetricKeyType === 'ed25519' ? 'ed25519' : privateKey.asymmetricKeyType === 'rsa' ? 'rsa' : 'ecdsa'
  const material = materialFromKeyPair(publicKey, privateKey, keyType)
  const line = [material.algorithm, material.publicBlob.toString('base64'), comment].filter(Boolean).join(' ')
  return `${line}\n`
}

/**
 * Fingerprint, bit count and type for a key — the replacement for
 * `ssh-keygen -l`. Accepts a private key in either format, or an
 * authorized_keys line.
 *
 * Returns null rather than throwing: this feeds a listing, where one
 * unreadable file should cost that file's metadata and not the list.
 */
export function inspectSshKey(text: string): SshKeyInfo | null {
  try {
    const trimmed = text.trim()
    if (!trimmed.startsWith('-----')) {
      // An authorized_keys line: algorithm, blob, optional comment.
      const [algorithm, base64] = trimmed.split(/\s+/)
      if (!algorithm || !base64) {
        return null
      }
      const blob = Buffer.from(base64, 'base64')
      // A blob names its own algorithm in its first field, and any real key
      // agrees with the word in front of it. Checking that is what separates
      // a key from an arbitrary line of text: without it, "not a key at all"
      // parses as an algorithm called "not" and reports a fingerprint of it.
      if (blob.length < 4 || blob.readUInt32BE(0) !== algorithm.length) {
        return null
      }
      if (blob.subarray(4, 4 + algorithm.length).toString('utf8') !== algorithm) {
        return null
      }
      return describe(algorithm, blob)
    }
    const parsed = parseOpenSshPrivateKey(trimmed)
    if (parsed) {
      return describe(parsed.algorithm, parsed.publicBlob)
    }
    const publicKey = createPublicKey(createPrivateKey(trimmed))
    const privateKey = createPrivateKey(trimmed)
    const keyType: SshKeyType =
      privateKey.asymmetricKeyType === 'ed25519' ? 'ed25519' : privateKey.asymmetricKeyType === 'rsa' ? 'rsa' : 'ecdsa'
    const material = materialFromKeyPair(publicKey, privateKey, keyType)
    return describe(material.algorithm, material.publicBlob)
  } catch {
    return null
  }
}
