import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { derivePublicKey, generateSshKey, inspectSshKey, type SshKeyType } from './ssh-key-format'

const TYPES: SshKeyType[] = ['ed25519', 'rsa', 'ecdsa']

// These tests speak two languages. The ones below need nothing but Node, and
// run everywhere. The OpenSSH round-trip needs the binary this module exists
// to stop depending on — so it is skipped rather than failed where it is
// absent, which is precisely the host this module is for.
const hasSshKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'pipe' })
    return true
  } catch (e) {
    // `-?` is not a real flag: usage on stderr means the binary is there.
    return /usage/i.test(String((e as { stderr?: Buffer }).stderr ?? ''))
  }
})()

test('generates the two files OpenSSH expects, in its formats', () => {
  for (const keyType of TYPES) {
    const key = generateSshKey(keyType, 'probe')
    assert.match(key.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/, keyType)
    assert.match(key.privateKey, /-----END OPENSSH PRIVATE KEY-----\n$/, keyType)
    // One authorized_keys line: algorithm, blob, comment.
    const fields = key.publicKey.trim().split(' ')
    assert.equal(fields.length, 3, keyType)
    assert.equal(fields[2], 'probe', keyType)
    assert.match(key.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/, keyType)
  }
})

test('a private key is never PKCS#8 — OpenSSH rejects that for ed25519', () => {
  // The gotcha this module was written around: Node's natural PEM export
  // reads as "invalid format" to OpenSSH, so armor is hand-built instead.
  const key = generateSshKey('ed25519')
  assert.ok(!key.privateKey.includes('BEGIN PRIVATE KEY'))
  assert.ok(!key.privateKey.includes('BEGIN EC PRIVATE KEY'))
})

test('the public half derived from a private key matches the one written beside it', () => {
  for (const keyType of TYPES) {
    const key = generateSshKey(keyType, 'probe')
    assert.equal(derivePublicKey(key.privateKey).trim(), key.publicKey.trim(), keyType)
  }
})

test('a derived public key keeps the comment stored in the key', () => {
  // `ssh-keygen -y` prints it, so dropping it would make this a near-miss
  // replacement rather than a replacement.
  const key = generateSshKey('ed25519', 'stored-comment')
  assert.ok(derivePublicKey(key.privateKey).trim().endsWith(' stored-comment'))
  // An explicit comment still wins.
  assert.ok(derivePublicKey(key.privateKey, 'override').trim().endsWith(' override'))
})

test('inspect reports the same fingerprint from either half', () => {
  for (const keyType of TYPES) {
    const key = generateSshKey(keyType, 'probe')
    const fromPrivate = inspectSshKey(key.privateKey)
    const fromPublic = inspectSshKey(key.publicKey)
    assert.equal(fromPrivate?.fingerprint, key.fingerprint, keyType)
    assert.equal(fromPublic?.fingerprint, key.fingerprint, keyType)
    assert.equal(fromPrivate?.type, key.type, keyType)
    assert.equal(fromPrivate?.bits, key.bits, keyType)
  }
})

test('the reported bit counts are the ones ssh-keygen prints', () => {
  assert.equal(generateSshKey('ed25519').bits, 256)
  assert.equal(generateSshKey('rsa').bits, 3072)
  assert.equal(generateSshKey('ecdsa').bits, 256)
})

test('unreadable input yields null rather than throwing', () => {
  // This feeds a directory listing: one bad file must cost its own row, not
  // the whole list.
  assert.equal(inspectSshKey(''), null)
  assert.equal(inspectSshKey('not a key at all'), null)
  assert.equal(inspectSshKey('-----BEGIN OPENSSH PRIVATE KEY-----\ngarbage\n-----END OPENSSH PRIVATE KEY-----'), null)
})

test('real OpenSSH accepts the keys, and the private half actually signs', {
  skip: hasSshKeygen ? false : 'ssh-keygen not installed',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-key-format-'))
  for (const keyType of TYPES) {
    const key = generateSshKey(keyType, 'probe')
    const path = join(dir, keyType)
    writeFileSync(path, key.privateKey, { mode: 0o600 })
    writeFileSync(`${path}.pub`, key.publicKey)

    const listed = execFileSync('ssh-keygen', ['-l', '-f', path], { encoding: 'utf8' }).trim()
    const [bits, fingerprint] = listed.split(/\s+/)
    assert.equal(fingerprint, key.fingerprint, `${keyType} fingerprint`)
    assert.equal(Number(bits), key.bits, `${keyType} bits`)
    assert.ok(listed.includes(`(${key.type})`), `${keyType} type: ${listed}`)

    assert.equal(
      execFileSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' }).trim(),
      key.publicKey.trim(),
      `${keyType} -y`,
    )

    // Signing is the only check here that exercises the PRIVATE fields:
    // everything above can be answered from the public blob stored inside
    // the file, so a mis-encoded private scalar would pass all of it.
    const message = join(dir, `${keyType}.txt`)
    writeFileSync(message, 'probe\n')
    writeFileSync(join(dir, `${keyType}.allowed`), `probe@opencroft ${key.publicKey.trim()}\n`)
    execFileSync('ssh-keygen', ['-Y', 'sign', '-f', path, '-n', 'file', message], { stdio: 'pipe' })
    execFileSync(
      'ssh-keygen',
      [
        '-Y',
        'verify',
        '-f',
        join(dir, `${keyType}.allowed`),
        '-I',
        'probe@opencroft',
        '-n',
        'file',
        '-s',
        `${message}.sig`,
      ],
      { input: 'probe\n', stdio: ['pipe', 'pipe', 'pipe'] },
    )
  }
})

test('a key imported from ssh-keygen still inspects and derives', {
  skip: hasSshKeygen ? false : 'ssh-keygen not installed',
}, () => {
  // The contract for keys already in a store, written before this existed.
  const dir = mkdtempSync(join(tmpdir(), 'ssh-key-import-'))
  const path = join(dir, 'imported')
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', path])
  const text = execFileSync('cat', [path], { encoding: 'utf8' })
  const real = execFileSync('ssh-keygen', ['-l', '-f', path], { encoding: 'utf8' }).trim()
  assert.equal(inspectSshKey(text)?.fingerprint, real.split(/\s+/)[1])
  assert.equal(
    derivePublicKey(text).trim(),
    execFileSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' }).trim(),
  )
})
