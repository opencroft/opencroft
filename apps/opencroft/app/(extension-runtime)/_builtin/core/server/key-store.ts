import host from '@ext/host'

// ═══════════════════════════════════════════════════════════════════
// Key Store
//
// Keys live in a per-node cache dir. Only ever expose key *metadata*
// (name/type/fingerprint) and *public* keys — private key material must
// never be returned to callers (e.g. agents driving node actions).
// ═══════════════════════════════════════════════════════════════════

const isWindows = host.os.platform() === 'win32'

export interface KeyEntry {
  name: string
  type: string
  fingerprint: string
  hasPublicKey: boolean
  inWsl: boolean
}

export function keyStoreDir(nodeId: string): string {
  return host.cacheDir('key-store', nodeId)
}

async function setKeyPermissions(filePath: string): Promise<void> {
  if (!isWindows) {
    await host.fs.chmod(filePath, 0o600)
    return
  }
  await host.execFile('icacls', [filePath, '/inheritance:r', '/grant:r', `${host.os.userInfo().username}:F`])
}

async function isPrivateKey(filePath: string): Promise<boolean> {
  try {
    const content = await host.fs.readFile(filePath, 'utf-8')
    return content.includes('PRIVATE KEY') || content.includes('-----BEGIN')
  } catch {
    return false
  }
}

async function isKeyInWsl(name: string): Promise<boolean> {
  try {
    await host.exec(`test -f ~/.ssh/keys/${name}`)
    return true
  } catch {
    return false
  }
}

// Run ssh-keygen, turning "binary not installed" into an actionable message
// instead of a cryptic ENOENT (openssh-client must be present on the host).
async function runSshKeygen(args: string[]): Promise<string> {
  try {
    return await host.execFile('ssh-keygen', args)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/enoent|not found|no such file/i.test(msg)) {
      throw new Error('ssh-keygen is not available — install openssh-client on the host running OpenCroft.')
    }
    throw err
  }
}

export async function keyStoreListKeys(storeId: string): Promise<KeyEntry[]> {
  const dir = keyStoreDir(storeId)
  let entries: string[]
  try {
    entries = await host.fs.readdir(dir)
  } catch {
    return []
  }
  const keys: KeyEntry[] = []
  for (const name of entries) {
    if (name.endsWith('.pub')) {
      continue
    }
    const filePath = host.path.join(dir, name)
    const stat = await host.fs.stat(filePath)
    if (!stat.isFile() || !(await isPrivateKey(filePath))) {
      continue
    }
    let type = 'unknown'
    let fingerprint = ''
    try {
      const info = await host.execFile('ssh-keygen', ['-l', '-f', filePath])
      const match = info.match(/^\d+\s+(\S+)\s+.*\((\w+)\)/)
      if (match) {
        fingerprint = match[1]
        type = match[2]
      }
    } catch {
      /* best effort */
    }
    let hasPublicKey = false
    try {
      await host.fs.access(`${filePath}.pub`)
      hasPublicKey = true
    } catch {
      /* no pub */
    }
    const inWsl = isWindows ? await isKeyInWsl(name) : false
    keys.push({ name, type, fingerprint, hasPublicKey, inWsl })
  }
  return keys
}

export async function keyStoreCreateKey(storeId: string, name: string, keyType: string): Promise<void> {
  const dir = keyStoreDir(storeId)
  await host.fs.mkdir(dir, { recursive: true })
  await runSshKeygen(['-t', keyType, '-f', host.path.join(dir, name), '-N', '', '-q'])
}

export async function keyStoreImportKey(storeId: string, name: string, content: string): Promise<void> {
  const dir = keyStoreDir(storeId)
  await host.fs.mkdir(dir, { recursive: true })
  const keyPath = host.path.join(dir, name)
  await host.fs.writeFile(keyPath, content)
  await setKeyPermissions(keyPath)
}

export async function keyStoreDeleteKey(storeId: string, name: string): Promise<void> {
  const dir = keyStoreDir(storeId)
  const keyPath = host.path.join(dir, name)
  await host.fs.unlink(keyPath).catch(() => null)
  await host.fs.unlink(`${keyPath}.pub`).catch(() => null)
}

export async function keyStoreReadPublicKey(storeId: string, name: string): Promise<string> {
  const keyPath = host.path.join(keyStoreDir(storeId), name)
  try {
    return await host.fs.readFile(`${keyPath}.pub`, 'utf-8')
  } catch {
    return runSshKeygen(['-y', '-f', keyPath])
  }
}

export async function keyStoreCopyKeyToWsl(storeId: string, name: string): Promise<void> {
  const keyPath = host.path.join(keyStoreDir(storeId), name)
  const content = await host.fs.readFile(keyPath, 'utf-8')
  await host.exec('mkdir -p ~/.ssh/keys')
  await host.exec(`cat > ~/.ssh/keys/${name} << 'KEYEOF'\n${content}\nKEYEOF`)
  await host.exec(`chmod 600 ~/.ssh/keys/${name}`)
  try {
    const pub = await host.fs.readFile(`${keyPath}.pub`, 'utf-8')
    await host.exec(`cat > ~/.ssh/keys/${name}.pub << 'KEYEOF'\n${pub}\nKEYEOF`)
  } catch {
    /* no pub */
  }
}

export async function keyStoreRemoveKeyFromWsl(name: string): Promise<void> {
  await host.exec(`rm -f ~/.ssh/keys/${name} ~/.ssh/keys/${name}.pub`)
}
