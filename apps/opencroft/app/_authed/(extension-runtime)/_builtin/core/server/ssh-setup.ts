import { exec, execFile, fs, os, path } from '@opencroft/server/system'
import { type ServerConfig, ssh } from '@opencroft/server/terminal'

import { keyStoreReadPublicKey } from './key-store'
import { parseKeyRef } from './key-store-checks'

// ═══════════════════════════════════════════════════════════════════
// SSH setup helpers
//
// Two distinct problems for remote Docker/Server nodes:
//  - host-key trust: the OpenSSH client (used by `docker -H ssh://`) verifies
//    the remote host key against known_hosts and fails closed when it's not
//    pinned. We let the user/agent scan and pin it explicitly.
//  - key auth: install a public key from a Key Store into the remote's
//    authorized_keys so non-interactive (key-only) transports can connect.
// ═══════════════════════════════════════════════════════════════════

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface HostKeyStatus {
  /** Whether the host already has a pinned key in known_hosts. */
  trusted: boolean
  /** SHA256 fingerprint of the remote's current host key, when reachable. */
  fingerprint?: string
  /** Populated when the host could not be scanned (e.g. unreachable). */
  error?: string
}

function knownHostsPath(): string {
  return path.join(os.homedir(), '.ssh', 'known_hosts')
}

/** `[host]:port` for non-standard ports, bare host for 22 — matches the format
 *  OpenSSH writes into known_hosts. */
function knownHostsHost(address: string, port: number): string {
  return port === 22 ? address : `[${address}]:${port}`
}

async function scanFingerprint(address: string, port: number): Promise<string | undefined> {
  try {
    const scanned = await execFile('ssh-keyscan', ['-p', String(port), address])
    if (!scanned.trim()) {
      return undefined
    }
    const info = await exec(`printf '%s' ${shellSingleQuote(scanned)} | ssh-keygen -lf - 2>/dev/null | head -n1`)
    const match = info.match(/\s(SHA256:\S+)\s/)
    return match ? match[1] : info.trim() || undefined
  } catch {
    return undefined
  }
}

/** Is this host already pinned in known_hosts, and what key does it present now? */
export async function hostKeyStatus(address: string, port: number): Promise<HostKeyStatus> {
  if (!address) {
    return { trusted: false, error: 'No address configured' }
  }
  let trusted = false
  try {
    await execFile('ssh-keygen', ['-F', knownHostsHost(address, port), '-f', knownHostsPath()])
    trusted = true
  } catch {
    trusted = false
  }
  const fingerprint = await scanFingerprint(address, port)
  if (!fingerprint && !trusted) {
    return { trusted, error: `Could not reach ${address}:${port} to read its host key` }
  }
  return { trusted, fingerprint }
}

/** Scan the remote host key and pin it into known_hosts (replacing any stale
 *  entry for the same host). Returns the pinned key's fingerprint. */
export async function acceptHostKey(address: string, port: number): Promise<HostKeyStatus> {
  if (!address) {
    throw new Error('No address configured')
  }
  let scanned: string
  try {
    scanned = await execFile('ssh-keyscan', ['-p', String(port), address])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/enoent|not found|no such file/i.test(msg)) {
      throw new Error('ssh-keyscan is not available — install openssh-client on the host running OpenCroft.')
    }
    throw err
  }
  if (!scanned.trim()) {
    throw new Error(`Could not reach ${address}:${port} to read its host key`)
  }
  const kh = knownHostsPath()
  const dir = path.join(os.homedir(), '.ssh')
  await fs.mkdir(dir, { recursive: true })
  // Drop any existing entry for this host so we don't accumulate duplicates.
  await execFile('ssh-keygen', ['-R', knownHostsHost(address, port), '-f', kh]).catch(() => null)
  await exec(
    `printf '%s\\n' ${shellSingleQuote(scanned.trim())} >> ${shellSingleQuote(kh)} && chmod 600 ${shellSingleQuote(kh)}`,
  )
  const fingerprint = await scanFingerprint(address, port)
  return { trusted: true, fingerprint }
}

/** Append a Key Store public key to the remote's authorized_keys, connecting
 *  with whatever auth the Server node currently has (typically a password). */
export async function installPublicKey(config: ServerConfig, publicKey: string): Promise<void> {
  const key = publicKey.trim()
  if (!key) {
    throw new Error('Public key is empty')
  }
  // base64 the key so no shell metacharacters in the comment can break the
  // remote command; decode and append only if not already present.
  const b64 = Buffer.from(key, 'utf-8').toString('base64')
  const script = [
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 600 ~/.ssh/authorized_keys',
    `K=$(printf '%s' '${b64}' | base64 -d)`,
    'grep -qF "$K" ~/.ssh/authorized_keys || printf \'%s\\n\' "$K" >> ~/.ssh/authorized_keys',
  ].join(' && ')
  await ssh.exec(config, script)
}

/** Resolve a `"<storeId>:<name>"` key reference to its public key text. */
export async function resolvePublicKey(keyRef: string): Promise<string> {
  const parsed = parseKeyRef(keyRef)
  if (!parsed) {
    throw new Error(`Invalid key reference: ${keyRef}`)
  }
  return keyStoreReadPublicKey(parsed.storeId, parsed.name)
}
