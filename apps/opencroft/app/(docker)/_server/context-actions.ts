import { spawn } from 'child_process'

import { createServerFn } from '@tanstack/react-start'

export interface DockerContext {
  name: string
  description: string
  dockerEndpoint: string
  host: string
  current: boolean
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    child.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(stderr))
        return
      }
      resolve(stdout)
    })
    child.on('error', reject)
  })
}

function runDocker(args: string[]): Promise<string> {
  return runCommand('wsl', ['--exec', 'docker', ...args])
}

async function resolveSSHHost(endpoint: string): Promise<string> {
  if (!endpoint.startsWith('ssh://')) {
    return ''
  }
  const target = endpoint.replace('ssh://', '')
  const sshHost = target.includes('@') ? target.split('@')[1] : target
  const output = await runCommand('wsl', ['--exec', 'ssh', '-G', sshHost])
  const match = output.match(/^hostname\s+(.+)$/m)
  return match ? match[1].trim() : sshHost
}

export const getDockerContexts = createServerFn().handler(async (): Promise<DockerContext[]> => {
  const stdout = await runDocker(['context', 'ls', '--format=json'])
  const items = stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))

  return Promise.all(
    items.map(async (json) => ({
      name: json.Name,
      description: json.Description || '',
      dockerEndpoint: json.DockerEndpoint || '',
      host: await resolveSSHHost(json.DockerEndpoint || ''),
      current: json.Current,
    })),
  )
})

export const getCurrentDockerContext = createServerFn().handler(async (): Promise<string> => {
  const stdout = await runDocker(['context', 'show'])
  return stdout.trim()
})

export const resolveServer = createServerFn({ method: 'POST' })
  .inputValidator((server: string) => server)
  .handler(async ({ data: server }): Promise<string> => {
    if (server !== 'localhost') {
      return server
    }
    const stdout = await runDocker(['context', 'ls', '--format={{.Name}}'])
    const names = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (names.includes('rootless')) {
      return 'rootless'
    }
    return 'default'
  })
