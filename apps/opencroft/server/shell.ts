import { execFile, spawn as nodeSpawn, type SpawnOptions } from 'child_process'
import os from 'os'
import type { Readable } from 'stream'

const isWindows = os.platform() === 'win32'

function log(cmd: string, args: string[]) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
}

export function exec(cmd: string, maxBuffer = 50 * 1024 * 1024): Promise<string> {
  if (isWindows) {
    log('wsl', ['--exec', 'bash', '-c', cmd])
    return new Promise((resolve, reject) => {
      execFile('wsl', ['--exec', 'bash', '-c', cmd], { maxBuffer, windowsHide: true }, (err, stdout) => {
        if (err) {
          reject(err)
          return
        }
        resolve(stdout)
      })
    })
  }

  log('bash', ['-c', cmd])
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', cmd], { maxBuffer }, (err, stdout) => {
      if (err) {
        reject(err)
        return
      }
      resolve(stdout)
    })
  })
}

export interface SpawnResult {
  stdout: string
  stderr: string
  code: number
}

export function spawn(cmd: string, args: string[], opts?: SpawnOptions): ReturnType<typeof nodeSpawn> {
  if (isWindows) {
    const fullArgs = ['--exec', cmd, ...args]
    log('wsl', fullArgs)
    return nodeSpawn('wsl', fullArgs, { windowsHide: true, ...opts })
  }
  log(cmd, args)
  return nodeSpawn(cmd, args, opts ?? {})
}

export function spawnPipe(cmd: string, args: string[], stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] })

    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `${cmd} exited with code ${code}`))
        return
      }
      resolve()
    })
    proc.on('error', reject)

    stream.pipe(proc.stdin!)
  })
}

export function readFile(path: string): Promise<string> {
  return exec(`cat '${path}'`)
}

let cachedHome: string | null = null

export async function homedir(): Promise<string> {
  if (cachedHome) {
    return cachedHome
  }
  const home = (await exec('echo $HOME')).trim()
  cachedHome = home
  return home
}
