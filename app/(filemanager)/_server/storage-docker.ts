import { spawn } from 'child_process'
import type { Readable } from 'stream'

import type { DockerConfig, FileEntry } from '@/app/(filemanager)/_lib/types'

function dockerArgs(config: DockerConfig): string[] {
  const args = ['docker']
  if (config.context && config.context !== 'default') {
    args.push('--context', config.context)
  }
  return args
}

function run(config: DockerConfig, cmd: string): Promise<string> {
  const args = ['--exec', ...dockerArgs(config), 'exec', config.containerId, 'sh', '-c', cmd]
  return new Promise((resolve, reject) => {
    const proc = spawn('wsl', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `exited with code ${code}`))
        return
      }
      resolve(stdout)
    })
    proc.on('error', reject)
  })
}

function resolvePath(config: DockerConfig, path: string) {
  const base = (config.basePath || '').replace(/\/+$/, '')
  const clean = path || '/'
  if (!base) {
    return clean
  }
  if (clean.startsWith('/')) {
    return base + clean
  }
  return base + '/' + clean
}

export async function listFiles(config: DockerConfig, path: string): Promise<FileEntry[]> {
  const fullPath = resolvePath(config, path)
  const cmd =
    `for f in '${fullPath}'/* '${fullPath}'/.*; do ` +
    '[ -e "$f" ] || continue; ' +
    'b=$(basename "$f"); ' +
    '[ "$b" = "." ] || [ "$b" = ".." ] && continue; ' +
    'if [ -d "$f" ]; then t=d; else t=f; fi; ' +
    's=$(stat -c "%s" "$f" 2>/dev/null || echo 0); ' +
    'm=$(stat -c "%Y" "$f" 2>/dev/null || echo 0); ' +
    'echo "$t|$b|$s|$m"; ' +
    'done | sort -t"|" -k2'

  const output = await run(config, cmd)

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
        modified: mtime ? new Date(parseInt(mtime) * 1000).toISOString() : '',
      }
    })
}

export async function downloadFile(config: DockerConfig, path: string): Promise<string> {
  const fullPath = resolvePath(config, path)
  const output = await run(config, `base64 '${fullPath}'`)
  return output.replace(/\s/g, '')
}

export async function uploadFile(config: DockerConfig, path: string, data: string, filename: string): Promise<void> {
  const dir = resolvePath(config, path)
  const fullPath = dir.endsWith('/') ? dir + filename : dir + '/' + filename
  await run(config, `echo '${data}' | base64 -d > '${fullPath}'`)
}

export async function uploadStream(config: DockerConfig, path: string, stream: Readable, filename: string): Promise<void> {
  const dir = resolvePath(config, path)
  const fullPath = dir.endsWith('/') ? dir + filename : dir + '/' + filename

  return new Promise((resolve, reject) => {
    const args = ['--exec', ...dockerArgs(config), 'exec', '-i', config.containerId, 'tee', fullPath]
    const proc = spawn('wsl', args, {
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `docker exec tee exited with code ${code}`))
        return
      }
      resolve()
    })
    proc.on('error', reject)

    stream.pipe(proc.stdin)
  })
}

export async function deleteFile(config: DockerConfig, path: string): Promise<void> {
  const fullPath = resolvePath(config, path)
  await run(config, `rm -rf '${fullPath}'`)
}

export async function renameFile(config: DockerConfig, oldPath: string, newPath: string): Promise<void> {
  const fullOld = resolvePath(config, oldPath)
  const fullNew = resolvePath(config, newPath)
  await run(config, `mv '${fullOld}' '${fullNew}'`)
}

export async function createDirectory(config: DockerConfig, path: string): Promise<void> {
  const fullPath = resolvePath(config, path)
  await run(config, `mkdir -p '${fullPath}'`)
}
