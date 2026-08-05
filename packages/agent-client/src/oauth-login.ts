// Interactive OAuth login for harnesses whose credentials live in the
// harness's own config files rather than an environment variable (e.g. Gemini
// CLI keeps rotating OAuth tokens under ~/.gemini). Such harnesses require the
// login to go through their own token manager, so this module drives a
// dedicated short-lived harness process in ACP mode: after `initialize`,
// `authenticate` with the OAuth method makes the process print the provider's
// consent URL on stdout (browserless mode) and wait for the authorization code
// on stdin. Neither the URL nor the code prompt is JSON-RPC — they are raw TUI
// output mixed into the same stream — so the raw stream is scanned instead of
// speaking through an ACP client connection. On success the harness writes its
// own credential files and every later session picks them up; token refresh
// stays inside the harness.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { findAdapter } from './resolve'

interface OauthSpec {
  // ACP authMethod id passed to `authenticate`.
  methodId: string
  // Credential files under the user's home dir; all present = connected.
  // The harness recreates them on login and rotates them afterwards.
  credsFiles: string[]
  // Extra harness state removed on disconnect (account cache etc.).
  disconnectExtraFiles: string[]
  // Environment that puts the harness into browserless OAuth mode.
  env: Record<string, string>
  // Matches the consent URL in the raw stdout stream.
  urlPattern: RegExp
}

const OAUTH_SPECS: Record<string, OauthSpec> = {
  'gemini-subscription': {
    methodId: 'oauth-personal',
    credsFiles: ['.gemini/oauth_creds.json'],
    disconnectExtraFiles: ['.gemini/google_accounts.json'],
    env: { NO_BROWSER: 'true', GEMINI_DEFAULT_AUTH_TYPE: 'oauth-personal' },
    urlPattern: /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'\u001b]+/,
  },
}

const URL_TIMEOUT_MS = 60_000
const CODE_TIMEOUT_MS = 180_000
// A started login the user never finishes is reaped after this long.
const FLOW_TTL_MS = 10 * 60_000
const BUFFER_CAP = 1_000_000

// Exported for tests: pull the consent URL out of raw TUI output.
export function extractOauthUrl(raw: string, pattern: RegExp): string | null {
  // TUI escape sequences can abut the URL with no whitespace; breaking the
  // stream at every ESC keeps them out of the match (the URL itself never
  // contains one).
  const cleaned = raw.replace(/\u001b/g, ' ')
  const match = cleaned.match(pattern)
  return match ? match[0] : null
}

// Exported for tests: parse complete JSON-RPC messages out of a mixed stream,
// skipping TUI noise and partial lines.
export function parseJsonRpcLines(raw: string): { id?: number; result?: unknown; error?: { message?: string } }[] {
  const messages: { id?: number; result?: unknown; error?: { message?: string } }[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }
    try {
      messages.push(JSON.parse(trimmed) as (typeof messages)[number])
    } catch {
      // Partial line or TUI text that happens to open a brace.
    }
  }
  return messages
}

interface LoginFlow {
  id: string
  adapterId: string
  child: ChildProcessWithoutNullStreams
  buffer: string
  stderrTail: string
  authRequested: boolean
  authUrl: string | null
  resolveUrl: ((url: string) => void) | null
  rejectUrl: ((error: Error) => void) | null
  outcome: Promise<{ ok: boolean; error?: string }>
  settleOutcome: (result: { ok: boolean; error?: string }) => void
  outcomeSettled: boolean
  ttlTimer: NodeJS.Timeout
}

// Survives dev hot-reloads, same as agent-client's session store.
const globalRef = globalThis as typeof globalThis & { __acpOauthLogins?: Map<string, LoginFlow> }
if (!globalRef.__acpOauthLogins) {
  globalRef.__acpOauthLogins = new Map()
}
const logins = globalRef.__acpOauthLogins

function isConnected(spec: OauthSpec): boolean {
  return spec.credsFiles.every((file) => existsSync(join(homedir(), file)))
}

function endFlow(flow: LoginFlow, error = 'Login attempt was cancelled') {
  clearTimeout(flow.ttlTimer)
  logins.delete(flow.id)
  if (!flow.outcomeSettled) {
    flow.outcomeSettled = true
    flow.settleOutcome({ ok: false, error })
  }
  flow.rejectUrl?.(new Error(error))
  flow.rejectUrl = null
  flow.resolveUrl = null
  if (flow.child.exitCode === null && !flow.child.killed) {
    flow.child.kill()
  }
}

function handleChunk(flow: LoginFlow, spec: OauthSpec, chunk: Buffer) {
  flow.buffer = (flow.buffer + chunk.toString()).slice(-BUFFER_CAP)
  const messages = parseJsonRpcLines(flow.buffer)
  if (!flow.authRequested && messages.some((m) => m.id === 0 && 'result' in m)) {
    flow.authRequested = true
    flow.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'authenticate', params: { methodId: spec.methodId } })}\n`,
    )
  }
  if (!flow.authUrl) {
    const url = extractOauthUrl(flow.buffer, spec.urlPattern)
    if (url) {
      flow.authUrl = url
      flow.resolveUrl?.(url)
      flow.resolveUrl = null
      flow.rejectUrl = null
    }
  }
  const auth = messages.find((m) => m.id === 1)
  if (auth && !flow.outcomeSettled) {
    flow.outcomeSettled = true
    flow.settleOutcome(
      auth.error ? { ok: false, error: auth.error.message ?? 'Authentication failed' } : { ok: true },
    )
  }
}

export interface OauthLoginStart {
  loginId: string
  authUrl: string
}

// Spawns the harness and returns the consent URL to show the user. The flow
// then waits (up to a TTL) for submitOauthCode with the code from the consent
// page. Starting a new login for the same adapter abandons the previous one.
export async function startOauthLogin(adapterId: string): Promise<OauthLoginStart> {
  const spec = OAUTH_SPECS[adapterId]
  const adapter = findAdapter(adapterId)
  if (!spec || !adapter) {
    throw new Error(`Adapter '${adapterId}' does not support OAuth login`)
  }
  for (const flow of [...logins.values()]) {
    if (flow.adapterId === adapterId) {
      endFlow(flow, 'Superseded by a new login attempt')
    }
  }

  const child = spawn(adapter.command, adapter.args, {
    // A neutral cwd: the login needs no workspace, and the harness would
    // otherwise scan whatever project directory it starts in.
    cwd: tmpdir(),
    env: { ...process.env, ...adapter.staticEnv, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let settleOutcome!: LoginFlow['settleOutcome']
  const outcome = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    settleOutcome = resolve
  })
  const flow: LoginFlow = {
    id: randomUUID(),
    adapterId,
    child,
    buffer: '',
    stderrTail: '',
    authRequested: false,
    authUrl: null,
    resolveUrl: null,
    rejectUrl: null,
    outcome,
    settleOutcome,
    outcomeSettled: false,
    ttlTimer: setTimeout(() => endFlow(flow, 'Login attempt expired'), FLOW_TTL_MS),
  }
  flow.ttlTimer.unref?.()
  logins.set(flow.id, flow)

  child.stdout.on('data', (chunk: Buffer) => handleChunk(flow, spec, chunk))
  child.stderr.on('data', (chunk: Buffer) => {
    flow.stderrTail = `${flow.stderrTail}${chunk.toString()}`.slice(-2000)
  })
  child.on('error', (error) => endFlow(flow, `Failed to launch the harness: ${error.message}`))
  child.on('exit', (code) => {
    if (!flow.outcomeSettled) {
      endFlow(flow, `Login process exited (${code ?? 'signal'}): ${flow.stderrTail.trim().slice(-300)}`)
    }
  })

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    })}\n`,
  )

  const authUrl = await new Promise<string>((resolve, reject) => {
    if (flow.authUrl) {
      resolve(flow.authUrl)
      return
    }
    flow.resolveUrl = resolve
    flow.rejectUrl = reject
    setTimeout(() => {
      if (!flow.authUrl) {
        endFlow(flow, 'Timed out waiting for the consent URL')
      }
    }, URL_TIMEOUT_MS).unref?.()
  })
  return { loginId: flow.id, authUrl }
}

// Feeds the user's authorization code to the waiting harness and reports how
// the login ended. The flow is finished either way; a failure means starting
// over from startOauthLogin.
export async function submitOauthCode(loginId: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const flow = logins.get(loginId)
  if (!flow) {
    return { ok: false, error: 'Login attempt expired — start again' }
  }
  const spec = OAUTH_SPECS[flow.adapterId]
  flow.child.stdin.write(`${code.trim()}\n`)
  const timeout = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    setTimeout(() => resolve({ ok: false, error: 'Timed out waiting for the login to finish' }), CODE_TIMEOUT_MS).unref?.()
  })
  const result = await Promise.race([flow.outcome, timeout])
  endFlow(flow)
  if (result.ok && spec && !isConnected(spec)) {
    return { ok: false, error: 'Login finished but no credentials were written' }
  }
  return result
}

export function oauthLoginStatus(adapterId: string): { supported: boolean; connected: boolean } {
  const spec = OAUTH_SPECS[adapterId]
  return { supported: Boolean(spec), connected: spec ? isConnected(spec) : false }
}

// Removes the harness's stored credentials (and account cache) and cancels any
// login still in flight. The harness re-creates everything on the next login.
export async function disconnectOauth(adapterId: string): Promise<{ connected: boolean }> {
  const spec = OAUTH_SPECS[adapterId]
  if (!spec) {
    throw new Error(`Adapter '${adapterId}' does not support OAuth login`)
  }
  for (const flow of [...logins.values()]) {
    if (flow.adapterId === adapterId) {
      endFlow(flow)
    }
  }
  for (const file of [...spec.credsFiles, ...spec.disconnectExtraFiles]) {
    await rm(join(homedir(), file), { force: true })
  }
  return { connected: false }
}
