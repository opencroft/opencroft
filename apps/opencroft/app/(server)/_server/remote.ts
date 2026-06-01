import { createServerFn } from '@tanstack/react-start'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'

import { getSshFeature, type Server, ServerOS, slug } from '@/app/(server)/_server/types'
import type { SshCredentials } from '@/app/(ssh)/_server/ssh-client'
import * as sshClient from '@/app/(ssh)/_server/ssh-client'
import * as sshConfig from '@/app/(ssh)/_server/ssh-config'

// --- SSH target resolution ---

function serverTarget(server: Server): string | SshCredentials {
  const ssh = getSshFeature(server)!

  // If keyPath is an absolute path, use credentials directly (dashboard servers)
  if (ssh.keyPath && path.isAbsolute(ssh.keyPath)) {
    return {
      host: server.address,
      port: ssh.port || 22,
      username: ssh.username || 'root',
      password: ssh.password,
      keyPath: ssh.keyPath,
    }
  }

  // Password-only: use credentials (ssh2 handles non-interactive password)
  if (ssh.password && !ssh.keyPath) {
    return {
      host: server.address,
      port: ssh.port || 22,
      username: ssh.username || 'root',
      password: ssh.password,
    }
  }

  // Key-based with relative/named path: use alias from ~/.ssh/config
  return slug(server.name)
}

// --- Remote execution ---

export const remoteExec = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { server: Server; command: string }) => data)
  .handler(async ({ data }) => {
    const { server, command } = data
    const ssh = getSshFeature(server)
    if (!ssh) {
      throw new Error('Server has no SSH feature')
    }

    return sshClient.exec(serverTarget(server), command)
  })

// --- OS detection ---

export const detectOS = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((server: Server) => server)
  .handler(async ({ data: server }) => {
    const uname = (await remoteExec({ data: { server, command: 'uname -s' } })).trim().toLowerCase()
    if (uname.includes('linux')) {
      return ServerOS.Linux
    }
    if (uname.includes('darwin')) {
      return ServerOS.Mac
    }
    if (uname.includes('mingw') || uname.includes('cygwin') || uname.includes('msys') || uname.includes('windows')) {
      return ServerOS.Windows
    }
    return ServerOS.Other
  })

// --- Server stats ---

export interface ServerStats {
  os: string
  kernel: string
  cpu: string
  memory: string
  storage: string
  uptime: string
}

export const getServerStats = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((server: Server) => server)
  .handler(async ({ data: server }) => {
    const script = [
      'echo "OS=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"',
      'echo "KERNEL=$(uname -r)"',
      'echo "CPU=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || echo unknown)x $(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs || uname -m)"',
      'echo "MEMORY=$(free -h 2>/dev/null | awk \'/^Mem:/{print $3"/"$2}\' || echo unknown)"',
      'echo "STORAGE=$(df -h / 2>/dev/null | awk \'NR==2{print $3"/"$2}\' || echo unknown)"',
      'echo "UPTIME=$(uptime -p 2>/dev/null || uptime | sed "s/.*up/up/" | cut -d, -f1)"',
    ].join(' && ')

    const output = await remoteExec({ data: { server, command: script } })
    const lines: Record<string, string> = {}
    for (const line of output.trim().split('\n')) {
      const [key, ...rest] = line.split('=')
      lines[key] = rest.join('=')
    }

    return {
      os: lines['OS'] || 'unknown',
      kernel: lines['KERNEL'] || 'unknown',
      cpu: lines['CPU'] || 'unknown',
      memory: lines['MEMORY'] || 'unknown',
      storage: lines['STORAGE'] || 'unknown',
      uptime: lines['UPTIME'] || 'unknown',
    }
  })

// --- Docker ---

export const checkDocker = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((server: Server) => server)
  .handler(async ({ data: server }) => {
    try {
      await remoteExec({ data: { server, command: 'docker --version' } })
      return true
    } catch {
      return false
    }
  })

export const installDockerUbuntu = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((server: Server) => server)
  .handler(async ({ data: server }) => {
    const ssh = getSshFeature(server)
    if (!ssh) {
      throw new Error('Server has no SSH feature')
    }

    const script = [
      'sudo apt-get update',
      'sudo apt-get install -y ca-certificates curl',
      'sudo install -m 0755 -d /etc/apt/keyrings',
      'sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
      'sudo chmod a+r /etc/apt/keyrings/docker.asc',
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null',
      'sudo apt-get update',
      'sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
      `sudo usermod -aG docker ${ssh.username || 'root'}`,
      'docker --version',
    ].join(' && ')

    const result = await remoteExec({ data: { server, command: script } })
    await createDockerContext({ data: server })
    return result
  })

// --- Docker context ---

function wslExec(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('wsl', ['--exec', 'bash', '-c', cmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
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

export const renameDockerContext = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((oldName: string) => oldName)
  .handler(async ({ data: oldName }) => {
    try {
      await wslExec(`docker context rm ${oldName} -f 2>/dev/null`)
    } catch {
      // old context may not exist
    }
  })

export const renameComposesFolder = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { oldSlug: string; newSlug: string }) => data)
  .handler(async ({ data }) => {
    const { oldSlug, newSlug } = data
    const basePath = 'data/docker/composes'
    try {
      await fs.rename(path.join(basePath, oldSlug), path.join(basePath, newSlug))
    } catch {
      // folder may not exist
    }
  })

export const createDockerContext = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((server: Server) => server)
  .handler(async ({ data: server }) => {
    const ssh = getSshFeature(server)
    if (!ssh) {
      throw new Error('Server has no SSH feature')
    }

    await sshConfig.setServer(server)

    const contextName = slug(server.name)
    const sshUrl = `ssh://${contextName}`

    const args = ['--exec', 'docker', 'context', 'create', contextName, '--docker', `host=${sshUrl}`]
    console.log(`$ wsl ${args.join(' ')}`)

    return new Promise((resolve, reject) => {
      const proc = spawn('wsl', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      let stderr = ''
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      proc.on('close', (code) => {
        if (code !== 0 && !stderr.includes('already exists')) {
          reject(new Error(stderr || `docker context create exited with code ${code}`))
          return
        }
        resolve()
      })
      proc.on('error', reject)
    })
  })
