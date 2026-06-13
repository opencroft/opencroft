import os from 'node:os'

import { type SshConfigEntry, sshConfig, sshKeys } from '@opencroft/terminal/server'

import { getSshFeature, type Server, slug } from '@/app/(server)/_server/types'

function serverEntry(server: Server): SshConfigEntry | null {
  const ssh = getSshFeature(server)
  if (!ssh?.keyPath) {
    return null
  }
  return {
    host: slug(server.name),
    properties: {
      HostName: server.address,
      User: ssh.username || 'root',
      Port: String(ssh.port || 22),
      IdentityFile: ssh.keyPath,
      StrictHostKeyChecking: 'no',
    },
  }
}

export async function setServer(server: Server): Promise<void> {
  const entry = serverEntry(server)
  if (!entry) {
    return
  }

  // Local config uses the key path as-is
  await sshConfig.local.set(entry)

  // WSL config: copy key and use WSL-relative path
  if (os.platform() === 'win32') {
    const ssh = getSshFeature(server)!
    const name = sshKeys.name(ssh.keyPath!)
    await sshKeys.copyToWsl(ssh.keyPath!, name)
    await sshConfig.wsl.set({
      ...entry,
      properties: { ...entry.properties, IdentityFile: `~/.ssh/keys/${name}` },
    })
  }
}

export async function removeServer(alias: string): Promise<void> {
  await sshConfig.remove(alias)
}
