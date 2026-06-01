import { exec, spawn } from 'child_process'
import type { Readable } from 'stream'

import type { FileEntry, WslConfig } from '@/app/(filemanager)/_lib/types'

function run(distro: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      `wsl -d ${distro} -- bash -c "${cmd.replace(/"/g, '\\"')}"`,
      {
        maxBuffer: 50 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message))
          return
        }
        resolve(stdout)
      },
    )
  })
}

function resolvePath(config: WslConfig, path: string) {
  const base = config.basePath.replace(/\/+$/, '')
  const clean = path || '/'
  if (clean.startsWith('/')) {
    return base + clean
  }
  return base + '/' + clean
}

export async function listFiles(config: WslConfig, path: string): Promise<FileEntry[]> {
  const fullPath = resolvePath(config, path)
  const output = await run(config.distro, `find '${fullPath}' -maxdepth 1 -mindepth 1 -printf '%y|%f|%s|%T@\\n' 2>/dev/null | sort`)

  if (!output.trim()) {
    return []
  }

  return output
    .trim()
    .split('\n')
    .map((line) => {
      const [typeChar, name, size, mtime] = line.split('|')
      const isDir = typeChar === 'd'
      const filePath = path.endsWith('/') ? path + name : path + '/' + name
      return {
        name,
        path: isDir ? filePath + '/' : filePath,
        type: isDir ? ('directory' as const) : ('file' as const),
        size: isDir ? 0 : parseInt(size) || 0,
        modified: mtime ? new Date(parseFloat(mtime) * 1000).toISOString() : '',
      }
    })
}

export async function downloadFile(config: WslConfig, path: string): Promise<string> {
  const fullPath = resolvePath(config, path)
  const output = await run(config.distro, `base64 '${fullPath}'`)
  return output.replace(/\s/g, '')
}

export async function uploadFile(config: WslConfig, path: string, data: string, filename: string): Promise<void> {
  const dir = resolvePath(config, path)
  const fullPath = dir.endsWith('/') ? dir + filename : dir + '/' + filename
  await run(config.distro, `echo '${data}' | base64 -d > '${fullPath}'`)
}

export async function uploadStream(config: WslConfig, path: string, stream: Readable, filename: string): Promise<void> {
  const dir = resolvePath(config, path)
  const fullPath = dir.endsWith('/') ? dir + filename : dir + '/' + filename

  return new Promise((resolve, reject) => {
    const proc = spawn('wsl', ['-d', config.distro, '--', 'tee', fullPath], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `wsl tee exited with code ${code}`))
        return
      }
      resolve()
    })
    proc.on('error', reject)

    stream.pipe(proc.stdin)
  })
}

export async function deleteFile(config: WslConfig, path: string): Promise<void> {
  const fullPath = resolvePath(config, path)
  await run(config.distro, `rm -rf '${fullPath}'`)
}

export async function renameFile(config: WslConfig, oldPath: string, newPath: string): Promise<void> {
  const fullOld = resolvePath(config, oldPath)
  const fullNew = resolvePath(config, newPath)
  await run(config.distro, `mv '${fullOld}' '${fullNew}'`)
}

export async function createDirectory(config: WslConfig, path: string): Promise<void> {
  const fullPath = resolvePath(config, path)
  await run(config.distro, `mkdir -p '${fullPath}'`)
}
