// Processes where a selection places its harness (resolve.ts harnessPlacement):
// the harness itself, through the host's RemoteShell when the spawn config
// names one, else on this machine (a `docker exec` config included, since its
// client runs here); the short scripts that read and write files in a place
// apart from this process; and two ready RemoteShells, this machine and a
// Docker container, for a host that wants every placement to be a shell.

import { spawn } from 'node:child_process'

import { containerReachableMcpUrl } from './mcp-url'
import { type HarnessPlacement, spawnEnvironment } from './resolve'
import type { HarnessProcess, RemoteShell, ShellResolver, SpawnConfig } from './types'

// The host's shell of `id`, or a refusal that names it.
function shellOf(id: string, shells: ShellResolver | undefined): RemoteShell {
  const shell = shells?.(id)
  if (!shell) {
    throw new Error(`The shell '${id}' this agent runs through is not known to this server.`)
  }
  return shell
}

export async function startHarnessProcess(
  config: SpawnConfig,
  shells: ShellResolver | undefined,
): Promise<HarnessProcess> {
  if (config.shell !== undefined) {
    return shellOf(config.shell, shells).spawn([config.command, ...config.args], config.env)
  }
  return spawn(config.command, config.args, {
    // Empty cwd (docker-exec form sets the container workdir itself) falls
    // back to the host default rather than failing to resolve.
    cwd: config.cwd || undefined,
    env: spawnEnvironment(process.env, config),
    stdio: ['pipe', 'pipe', 'pipe'],
    // On Windows, launchers like `npx`/`npm` are `.cmd` scripts that Node's
    // spawn can't resolve on PATH without a shell, so they ENOENT otherwise.
    // Args here come from the fixed harness-adapter table, not user input.
    shell: process.platform === 'win32',
  })
}

/** Runs `sh -c <script>` where the harness runs, with `stdin`, and resolves its stdout. */
export type ShellRunner = (script: string, stdin: string, env: Record<string, string>) => Promise<string>

// A file operation is over in seconds; a place that does not answer in this
// long is treated as unreachable rather than waited on by the session.
const PLACED_SCRIPT_TIMEOUT_MS = 30_000

/**
 * The shell of a place a harness runs in apart from this process: `docker
 * exec` into its container as the container's own user, the one its harness
 * runs as, with `env` forwarded by name; or the host's RemoteShell.
 */
export function placedShell(
  placement: Exclude<HarnessPlacement, { kind: 'host' }>,
  shells: ShellResolver | undefined,
): ShellRunner {
  if (placement.kind === 'shell') {
    const id = placement.shell
    return (script, stdin, env) =>
      runScript(
        async (argv, scriptEnv) => shellOf(id, shells).spawn(argv, scriptEnv),
        script,
        stdin,
        env,
        PLACED_SCRIPT_TIMEOUT_MS,
        `The shell '${id}'`,
      )
  }
  const { container } = placement
  return (script, stdin, env) =>
    runScript(
      async (argv, scriptEnv) => dockerExec(container, argv, scriptEnv),
      script,
      stdin,
      env,
      PLACED_SCRIPT_TIMEOUT_MS,
      `docker exec in ${container}`,
    )
}

// `argv` in `container` through this machine's `docker`, as the container's
// own user, with `env` forwarded by name so no value is in the command line.
function dockerExec(container: string, argv: string[], env: Record<string, string>): HarnessProcess {
  return spawn('docker', ['exec', '-i', ...Object.keys(env).flatMap((name) => ['-e', name]), container, ...argv], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * A RemoteShell on this machine: processes start here, with this process's
 * environment under theirs. What a selection naming no shell runs on, offered
 * for a host that wants every placement to be a shell.
 */
export function localShell(id = 'local'): RemoteShell {
  return {
    id,
    async spawn(argv, env) {
      const [command, ...args] = argv
      return spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    },
    mcpUrl: (loopbackUrl) => loopbackUrl,
    describe: async () => 'this machine',
  }
}

/**
 * A RemoteShell into a Docker container this machine's `docker` reaches, the
 * way a selection's `containerName` runs: as the container's own user, with
 * the MCP server's address one that sibling container resolves.
 */
export function dockerExecShell(container: string): RemoteShell {
  return {
    id: `docker:${container}`,
    async spawn(argv, env) {
      return dockerExec(container, argv, env)
    },
    mcpUrl: containerReachableMcpUrl,
    describe: async () => `container "${container}"`,
  }
}

/**
 * Runs `sh -c <script>` through `start` with `stdin`, and resolves its stdout;
 * rejects with its stderr, or how it ended, when it does not exit 0, and when
 * it has not ended after `timeoutMs`.
 */
function runScript(
  start: (argv: string[], env: Record<string, string>) => Promise<HarnessProcess>,
  script: string,
  stdin: string,
  env: Record<string, string>,
  timeoutMs: number,
  where: string,
): Promise<string> {
  return start(['sh', '-c', script], env).then(
    (child) =>
      new Promise<string>((resolve, reject) => {
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let timedOut = false
        let settled = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, timeoutMs)
        const fail = (error: Error) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(error)
          }
        }
        // A local process can report its exit before the last of its output
        // is read, so the answer waits for both streams to end as well.
        let pending = 3
        let ended: { code: number | null; signal: string | null } | undefined
        const done = () => {
          pending -= 1
          if (pending > 0 || settled || !ended) {
            return
          }
          const { code, signal } = ended
          if (timedOut) {
            fail(new Error(`${where} did not answer within ${timeoutMs / 1000}s`))
          } else if (code !== 0) {
            const detail = Buffer.concat(stderr).toString('utf8').trim()
            fail(new Error(detail || `${where} ended with ${signal ?? `exit code ${code}`}`))
          } else {
            settled = true
            clearTimeout(timer)
            resolve(Buffer.concat(stdout).toString('utf8'))
          }
        }
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.stdout.on('end', done)
        child.stderr.on('end', done)
        child.stdin.on('error', () => {
          // A process that exits before reading its input closes the pipe;
          // how it ended is reported by 'exit'.
        })
        // A process that could not start, or whose channel was lost, may
        // never end its streams.
        child.on('error', fail)
        child.on('exit', (code, signal) => {
          ended = { code, signal }
          done()
        })
        child.stdin.end(stdin)
      }),
  )
}
