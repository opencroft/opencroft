// Interactive sign-in for harnesses whose credentials live in the harness's own
// files rather than an environment variable. Such harnesses require the login
// to go through their own token manager, so this module drives a dedicated
// short-lived harness process and lets the harness write and later rotate the
// credentials itself; every later session picks them up. Two kinds, each with
// its own driver:
//  - paste-code (./oauth-paste-code): the user opens a consent URL and pastes
//    the authorization code it shows back in (submitOauthCode);
//  - device-code (./oauth-device-code): the user opens a verification URL and
//    enters a one-time code there, while the login waits (awaitOauthLogin).

import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { errorMessage } from './errors'
import type { HarnessAdapter } from './harness-adapters'
import { driveDeviceCodeLogin } from './oauth-device-code'
import { drivePasteCodeLogin } from './oauth-paste-code'
import { buildSpawnConfig, findAdapter, harnessHomeDir } from './resolve'
import type { AgentSelection } from './types'

// Where the agent that signs in runs: the same two fields its sessions are
// spawned with, so a login lands in the home those sessions read.
export type OauthPlacement = Pick<AgentSelection, 'harnessHome' | 'containerName'>

interface PasteCodeSpec {
  kind: 'paste-code'
  // ACP authMethod id passed to `authenticate`.
  methodId: string
  // Credential files under the server user's home dir; all present =
  // connected. The harness recreates them on login and rotates them afterwards.
  // The login process runs on the server, so an agent run in a container does
  // not see them — this kind signs in host-run agents only.
  credsFiles: string[]
  // Extra harness state removed on disconnect (account cache etc.).
  disconnectExtraFiles: string[]
  // Environment that puts the harness into browserless OAuth mode.
  env: Record<string, string>
  // Matches the consent URL in the raw stdout stream, once extractOauthUrl has
  // turned every ESC into a space.
  urlPattern: RegExp
}

interface DeviceCodeSpec {
  kind: 'device-code'
  methodId: string
  // Credential files relative to the adapter's harness home (its `homeEnv`),
  // wherever the agent runs — inside its container for a container agent.
  credsFiles: string[]
}

type OauthSpec = PasteCodeSpec | DeviceCodeSpec

const OAUTH_SPECS: Record<string, OauthSpec> = {
  'gemini-subscription': {
    kind: 'paste-code',
    methodId: 'oauth-personal',
    credsFiles: ['.gemini/oauth_creds.json'],
    disconnectExtraFiles: ['.gemini/google_accounts.json'],
    env: { NO_BROWSER: 'true', GEMINI_DEFAULT_AUTH_TYPE: 'oauth-personal' },
    urlPattern: /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"']+/,
  },
  'codex-subscription': {
    kind: 'device-code',
    methodId: 'chat-gpt-device-code',
    // Codex keeps its login as auth.json directly in CODEX_HOME — ~/.codex is
    // only the default home. Measured on codex-acp 1.13.1: a login into a
    // fresh CODEX_HOME writes <home>/auth.json and nothing under .codex/.
    credsFiles: ['auth.json'],
  },
}

// How long the harness may take to produce the link (and code) to show.
const PROMPT_TIMEOUT_MS = 60_000
const CODE_TIMEOUT_MS = 180_000
// How long one awaitOauthLogin call holds before answering "still pending".
const RESULT_WAIT_MS = 20_000
// A started login the user never finishes is reaped after this long.
const FLOW_TTL_MS = 10 * 60_000

export type OauthLoginStart =
  // Open authUrl, then hand the code it shows to submitOauthCode.
  | { kind: 'paste-code'; loginId: string; authUrl: string }
  // Open verificationUrl and enter userCode there, then awaitOauthLogin.
  | { kind: 'device-code'; loginId: string; verificationUrl: string; userCode: string | null; message: string }
  // The harness already held a valid login; nothing to do.
  | { kind: 'signed-in' }

export interface OauthLoginResult {
  ok: boolean
  error?: string
}

interface LoginFlow {
  id: string
  adapterId: string
  // One live login per scope: the adapter plus where its credentials land.
  scope: string
  placement: OauthPlacement
  child: ChildProcessWithoutNullStreams
  stderrTail: string
  // What the caller of startOauthLogin shows the user. Settled once.
  showPrompt: (prompt: OauthLoginStart) => void
  failPrompt: (error: Error) => void
  promptSettled: boolean
  outcome: Promise<OauthLoginResult>
  settleOutcome: (result: OauthLoginResult) => void
  outcomeSettled: boolean
  ttlTimer: NodeJS.Timeout
}

// Survives dev hot-reloads, same as agent-client's session store.
const globalRef = globalThis as typeof globalThis & { __acpOauthLogins?: Map<string, LoginFlow> }
if (!globalRef.__acpOauthLogins) {
  globalRef.__acpOauthLogins = new Map()
}
const logins = globalRef.__acpOauthLogins

function oauthTarget(adapterId: string): { spec: OauthSpec; adapter: HarnessAdapter } {
  const spec = OAUTH_SPECS[adapterId]
  const adapter = findAdapter(adapterId)
  if (!spec || !adapter) {
    throw new Error(`Adapter '${adapterId}' does not support OAuth login`)
  }
  return { spec, adapter }
}

// The absolute harness home a device-code login writes to. Required: without
// the host's harness home the engine falls back to a directory relative to
// each agent's workdir, which a standalone login process cannot reproduce.
function loginHarnessHome(adapter: HarnessAdapter, placement: OauthPlacement): string {
  if (!placement.harnessHome) {
    throw new Error(`${adapter.label} signs in into the agent's own harness home, and none was given.`)
  }
  return harnessHomeDir(adapter, placement)
}

interface FileLocation {
  paths: string[]
  // Undefined: the files are on this machine.
  containerName?: string
}

function credentialLocation(
  spec: OauthSpec,
  adapter: HarnessAdapter,
  placement: OauthPlacement,
  files: string[],
): FileLocation {
  if (spec.kind === 'paste-code') {
    return { paths: files.map((file) => join(homedir(), file)) }
  }
  const home = loginHarnessHome(adapter, placement)
  return { paths: files.map((file) => `${home}/${file}`), containerName: placement.containerName }
}

const execFileAsync = promisify(execFile)

async function allFilesExist(location: FileLocation): Promise<boolean> {
  if (!location.containerName) {
    return location.paths.every((path) => existsSync(path))
  }
  try {
    await execFileAsync('docker', [
      'exec',
      location.containerName,
      'sh',
      '-c',
      'for f; do test -f "$f" || exit 3; done',
      'sh',
      ...location.paths,
    ])
    return true
  } catch (error) {
    // Exit 3 is the script's own "a file is missing"; anything else (the
    // container is down, docker is missing) is not an answer about the files.
    if ((error as { code?: unknown }).code === 3) {
      return false
    }
    throw new Error(`Could not check the sign-in inside container '${location.containerName}': ${errorMessage(error)}`)
  }
}

async function removeFiles(location: FileLocation): Promise<void> {
  if (!location.containerName) {
    await Promise.all(location.paths.map((path) => rm(path, { force: true })))
    return
  }
  await execFileAsync('docker', ['exec', location.containerName, 'rm', '-f', '--', ...location.paths])
}

async function isConnected(spec: OauthSpec, adapter: HarnessAdapter, placement: OauthPlacement): Promise<boolean> {
  return allFilesExist(credentialLocation(spec, adapter, placement, spec.credsFiles))
}

// Records how the login ended and stops the process; the flow stays
// registered so its caller can still read the outcome.
function settle(flow: LoginFlow, result: OauthLoginResult) {
  if (!flow.outcomeSettled) {
    flow.outcomeSettled = true
    flow.settleOutcome(result)
  }
  if (!flow.promptSettled) {
    if (result.ok) {
      flow.showPrompt({ kind: 'signed-in' })
    } else {
      flow.failPrompt(new Error(result.error ?? 'Login failed'))
    }
  }
  if (flow.child.exitCode === null && !flow.child.killed) {
    flow.child.kill()
  }
}

function endFlow(flow: LoginFlow, error = 'Login attempt was cancelled') {
  clearTimeout(flow.ttlTimer)
  logins.delete(flow.id)
  settle(flow, { ok: false, error })
}

// A device-code login is spawned exactly as the agent's sessions are; the
// paste-code kind runs on the server with its fixed browserless environment.
async function spawnLoginProcess(
  spec: OauthSpec,
  adapter: HarnessAdapter,
  placement: OauthPlacement,
): Promise<ChildProcessWithoutNullStreams> {
  if (spec.kind === 'paste-code') {
    return spawn(adapter.command, adapter.args, {
      // A neutral cwd: the login needs no workspace, and the harness would
      // otherwise scan whatever project directory it starts in.
      cwd: tmpdir(),
      env: { ...process.env, ...adapter.staticEnv, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }
  // Refuses before anything is spawned when there is no home to sign in to.
  loginHarnessHome(adapter, placement)
  // Built by the same function as the agent's sessions, so the home variable,
  // the fixed environment and the container wrapping are theirs. No provider
  // and no key: signing in needs neither.
  const config = buildSpawnConfig({
    providerId: '',
    adapterId: adapter.id,
    model: '',
    apiKey: '',
    cwd: placement.containerName ? '' : tmpdir(),
    harnessHome: placement.harnessHome,
    containerName: placement.containerName,
  })
  for (const dir of config.ensureDirs ?? []) {
    await mkdir(dir, { recursive: true })
  }
  return spawn(config.command, config.args, {
    cwd: config.cwd || undefined,
    env: { ...process.env, ...config.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function loginScope(spec: OauthSpec, adapterId: string, placement: OauthPlacement): string {
  return spec.kind === 'paste-code'
    ? adapterId
    : JSON.stringify([adapterId, placement.containerName ?? '', placement.harnessHome ?? ''])
}

// Spawns the harness and returns what to show the user: a consent URL to open
// and paste a code back from (then submitOauthCode), or a verification URL and
// a one-time code to enter there (then awaitOauthLogin). The flow waits up to
// a TTL. Starting a new login for the same adapter and home abandons the
// previous one.
export async function startOauthLogin(adapterId: string, placement: OauthPlacement = {}): Promise<OauthLoginStart> {
  const { spec, adapter } = oauthTarget(adapterId)
  const scope = loginScope(spec, adapterId, placement)
  for (const flow of [...logins.values()]) {
    if (flow.scope === scope) {
      endFlow(flow, 'Superseded by a new login attempt')
    }
  }
  const child = await spawnLoginProcess(spec, adapter, placement)

  let showPrompt!: (prompt: OauthLoginStart) => void
  let failPrompt!: (error: Error) => void
  const prompt = new Promise<OauthLoginStart>((resolve, reject) => {
    showPrompt = resolve
    failPrompt = reject
  })
  let settleOutcome!: LoginFlow['settleOutcome']
  const outcome = new Promise<OauthLoginResult>((resolve) => {
    settleOutcome = resolve
  })
  const flow: LoginFlow = {
    id: randomUUID(),
    adapterId,
    scope,
    placement,
    child,
    stderrTail: '',
    showPrompt: (value) => {
      if (!flow.promptSettled) {
        flow.promptSettled = true
        showPrompt(value)
      }
    },
    failPrompt: (error) => {
      if (!flow.promptSettled) {
        flow.promptSettled = true
        failPrompt(error)
      }
    },
    promptSettled: false,
    outcome,
    settleOutcome,
    outcomeSettled: false,
    ttlTimer: setTimeout(() => endFlow(flow, 'Login attempt expired'), FLOW_TTL_MS),
  }
  flow.ttlTimer.unref?.()
  logins.set(flow.id, flow)

  child.stderr.on('data', (chunk: Buffer) => {
    flow.stderrTail = `${flow.stderrTail}${chunk.toString()}`.slice(-2000)
  })
  child.on('error', (error) => settle(flow, { ok: false, error: `Failed to launch the harness: ${error.message}` }))
  child.on('exit', (code) => {
    settle(flow, {
      ok: false,
      error: `Login process exited (${code ?? 'signal'}): ${flow.stderrTail.trim().slice(-300)}`,
    })
  })
  const done = (result: OauthLoginResult) => settle(flow, result)
  if (spec.kind === 'paste-code') {
    drivePasteCodeLogin(child, spec, {
      prompt: (authUrl) => flow.showPrompt({ kind: 'paste-code', loginId: flow.id, authUrl }),
      done,
    })
  } else {
    driveDeviceCodeLogin(
      child,
      { methodId: spec.methodId, label: adapter.label },
      { prompt: (shown) => flow.showPrompt({ kind: 'device-code', loginId: flow.id, ...shown }), done },
    )
  }

  setTimeout(() => {
    if (!flow.promptSettled) {
      settle(flow, { ok: false, error: 'Timed out waiting for the sign-in link' })
    }
  }, PROMPT_TIMEOUT_MS).unref?.()
  try {
    const shown = await prompt
    if (shown.kind === 'signed-in') {
      endFlow(flow)
    }
    return shown
  } catch (error) {
    endFlow(flow)
    throw error
  }
}

// Ends a flow the caller has read the outcome of, confirming that a success
// actually left the credentials where the agent's sessions will read them.
async function finishFlow(flow: LoginFlow, result: OauthLoginResult): Promise<OauthLoginResult> {
  endFlow(flow)
  const { spec, adapter } = oauthTarget(flow.adapterId)
  if (result.ok && !(await isConnected(spec, adapter, flow.placement))) {
    return { ok: false, error: 'Login finished but no credentials were written' }
  }
  return result
}

// Feeds the user's authorization code to a waiting paste-code login and
// reports how it ended. The flow is finished either way; a failure means
// starting over from startOauthLogin.
export async function submitOauthCode(loginId: string, code: string): Promise<OauthLoginResult> {
  const flow = logins.get(loginId)
  if (!flow) {
    return { ok: false, error: 'Login attempt expired — start again' }
  }
  // A process that already ended would take the write as a broken pipe.
  if (!flow.outcomeSettled) {
    flow.child.stdin.write(`${code.trim()}\n`)
  }
  const timeout = new Promise<OauthLoginResult>((resolve) => {
    setTimeout(
      () => resolve({ ok: false, error: 'Timed out waiting for the login to finish' }),
      CODE_TIMEOUT_MS,
    ).unref?.()
  })
  return finishFlow(flow, await Promise.race([flow.outcome, timeout]))
}

// How a device-code login ended, waiting up to `waitMs` for it: the user
// finishes it on another device, so the caller asks again while this answers
// `pending`. A settled outcome is returned once and ends the flow.
export async function awaitOauthLogin(
  loginId: string,
  waitMs = RESULT_WAIT_MS,
): Promise<OauthLoginResult | { pending: true }> {
  const flow = logins.get(loginId)
  if (!flow) {
    return { ok: false, error: 'Login attempt expired — start again' }
  }
  let timer: NodeJS.Timeout | undefined
  const pending = new Promise<{ pending: true }>((resolve) => {
    timer = setTimeout(() => resolve({ pending: true }), waitMs)
    timer.unref?.()
  })
  const result = await Promise.race([flow.outcome, pending])
  clearTimeout(timer)
  if ('pending' in result) {
    return result
  }
  return finishFlow(flow, result)
}

export async function oauthLoginStatus(
  adapterId: string,
  placement: OauthPlacement = {},
): Promise<{ supported: boolean; connected: boolean }> {
  const spec = OAUTH_SPECS[adapterId]
  const adapter = findAdapter(adapterId)
  if (!spec || !adapter) {
    return { supported: false, connected: false }
  }
  return { supported: true, connected: await isConnected(spec, adapter, placement) }
}

// Removes the harness's stored credentials (and account cache) and cancels any
// login still in flight for that home. The harness re-creates everything on
// the next login. A harness process already running keeps whatever login it
// loaded until it is restarted.
export async function disconnectOauth(
  adapterId: string,
  placement: OauthPlacement = {},
): Promise<{ connected: false }> {
  const { spec, adapter } = oauthTarget(adapterId)
  const scope = loginScope(spec, adapterId, placement)
  for (const flow of [...logins.values()]) {
    if (flow.scope === scope) {
      endFlow(flow)
    }
  }
  const extra = spec.kind === 'paste-code' ? spec.disconnectExtraFiles : []
  await removeFiles(credentialLocation(spec, adapter, placement, [...spec.credsFiles, ...extra]))
  return { connected: false }
}
