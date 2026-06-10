import type { SshCredentials } from '@opencroft/terminal'
import { ssh as sshClient } from '@opencroft/terminal/server'
import type { Readable } from 'stream'
import type { FileEntry, SshConfig } from '@/app/(filemanager)/_lib/types'

function toCreds(config: SshConfig): SshCredentials {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    keyPath: config.privateKey,
  }
}

function resolvePath(config: SshConfig, p: string) {
  const base = config.basePath.replace(/\/+$/, '')
  const clean = p || '/'
  if (clean.startsWith('/')) {
    return base + clean
  }
  return base + '/' + clean
}

export async function listFiles(config: SshConfig, path: string): Promise<FileEntry[]> {
  const fullPath = resolvePath(config, path)
  const entries = await sshClient.sftp.list(toCreds(config), fullPath)

  return entries.map((item) => ({
    name: item.name,
    path: (path.endsWith('/') ? path : path + '/') + item.name,
    type: item.isDirectory ? ('directory' as const) : ('file' as const),
    size: item.size,
    modified: new Date(item.mtime * 1000).toISOString(),
  }))
}

export async function downloadFile(config: SshConfig, path: string): Promise<string> {
  const fullPath = resolvePath(config, path)
  const data = await sshClient.sftp.read(toCreds(config), fullPath)
  return data.toString('base64')
}

export async function uploadFile(config: SshConfig, path: string, data: string, filename: string): Promise<void> {
  const dir = resolvePath(config, path)
  const fullPath = dir.endsWith('/') ? dir + filename : dir + '/' + filename
  await sshClient.sftp.write(toCreds(config), fullPath, Buffer.from(data, 'base64'))
}

export async function uploadStream(config: SshConfig, path: string, stream: Readable, filename: string): Promise<void> {
  const dir = resolvePath(config, path)
  const fullPath = dir.endsWith('/') ? dir + filename : dir + '/' + filename
  await sshClient.upload(toCreds(config), fullPath, stream)
}

export async function deleteFile(config: SshConfig, path: string): Promise<void> {
  const fullPath = resolvePath(config, path)
  await sshClient.sftp.remove(toCreds(config), fullPath)
}

export async function renameFile(config: SshConfig, oldPath: string, newPath: string): Promise<void> {
  const fullOld = resolvePath(config, oldPath)
  const fullNew = resolvePath(config, newPath)
  await sshClient.sftp.rename(toCreds(config), fullOld, fullNew)
}

export async function createDirectory(config: SshConfig, path: string): Promise<void> {
  const fullPath = resolvePath(config, path)
  await sshClient.sftp.mkdir(toCreds(config), fullPath)
}
