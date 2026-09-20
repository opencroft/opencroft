import { execFile as execFileCb } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { SIDECAR_FILE } from '@/app/_authed/(extension-runtime)/_server/paths'
import { getSecretValue } from '@/app/_authed/(secrets-store)/_server/actions'

const execFile = promisify(execFileCb)

// The parts of keeping an extension's checkout on disk that both the installed
// extensions and the local ones need: where it came from, how to authenticate
// to that remote, and how to bring its node dependencies into line after its
// files move. Held in a plain module rather than beside the actions, because a
// file that exports a server function may export nothing else (see
// scripts/check-server-fn-colocation.mjs) — so a second caller cannot reach a
// helper that lives there.

export interface InstalledSource {
  type: 'git'
  url: string
  name: string
}

export interface InstallAuth {
  type: 'secret'
  storeId: string
  usernameKey?: string
  tokenKey?: string
}

export interface ResolvedAuth {
  username: string
  token: string
}

/** What an extension directory records about where it came from. Written by an
 *  install, and present in a local checkout that was installed rather than
 *  cloned by hand — which is why reading it always has to allow for absence. */
export interface InstalledSidecar {
  source: InstalledSource
  auth?: InstallAuth
  ref: string
  installedAt: number
}

export async function readSidecar(dir: string): Promise<InstalledSidecar | null> {
  try {
    const raw = await fs.readFile(path.join(dir, SIDECAR_FILE), 'utf-8')
    return JSON.parse(raw) as InstalledSidecar
  } catch {
    return null
  }
}

export async function writeSidecar(dir: string, sidecar: InstalledSidecar): Promise<void> {
  await fs.writeFile(path.join(dir, SIDECAR_FILE), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf-8')
}

export async function resolveAuth(auth?: InstallAuth): Promise<ResolvedAuth | null> {
  if (!auth) {
    return null
  }
  const tokenKey = auth.tokenKey ?? 'token'
  const usernameKey = auth.usernameKey ?? 'username'
  const [token, username] = await Promise.all([
    getSecretValue({ data: { storeId: auth.storeId, key: tokenKey } }),
    getSecretValue({ data: { storeId: auth.storeId, key: usernameKey } }),
  ])
  if (!token) {
    throw new Error(`Secret ${auth.storeId}/${tokenKey} not found or empty`)
  }
  return { username: username ?? 'x-access-token', token }
}

export async function installNodeDeps(dir: string): Promise<void> {
  try {
    await fs.access(path.join(dir, 'package.json'))
  } catch {
    return
  }
  try {
    await execFile('npm', ['install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', '--no-progress'], {
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
      shell: true,
    })
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const text = e.stderr || e.stdout || e.message || String(err)
    const tail = text.split('\n').slice(-15).join('\n')
    throw new Error(`npm install failed in ${dir}:\n${tail}`)
  }
}
