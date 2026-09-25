// The paste-code sign-in driver (Gemini CLI): after `initialize`,
// `authenticate` with the OAuth method makes the process print the provider's
// consent URL on stdout (browserless mode) and wait for the authorization code
// on stdin. Neither the URL nor the code prompt is JSON-RPC — they are raw TUI
// output mixed into the same stream — so the raw stream is scanned instead of
// speaking through an ACP client connection. The code itself is written to
// stdin by ./oauth-login when the user submits it.

import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { OauthLoginResult } from './oauth-login'

const BUFFER_CAP = 1_000_000

// Exported for tests: pull the consent URL out of raw TUI output.
export function extractOauthUrl(raw: string, pattern: RegExp): string | null {
  // TUI escape sequences can abut the URL with no whitespace; breaking the
  // stream at every ESC keeps them out of the match (the URL itself never
  // contains one), so a pattern need not exclude ESC itself.
  const cleaned = raw.replaceAll('\u001b', ' ')
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

export function drivePasteCodeLogin(
  child: ChildProcessWithoutNullStreams,
  spec: { methodId: string; urlPattern: RegExp },
  on: { prompt: (authUrl: string) => void; done: (result: OauthLoginResult) => void },
): void {
  let buffer = ''
  let authRequested = false
  let urlShown = false
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = (buffer + chunk.toString()).slice(-BUFFER_CAP)
    const messages = parseJsonRpcLines(buffer)
    if (!authRequested && messages.some((m) => m.id === 0 && 'result' in m)) {
      authRequested = true
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'authenticate', params: { methodId: spec.methodId } })}\n`,
      )
    }
    if (!urlShown) {
      const authUrl = extractOauthUrl(buffer, spec.urlPattern)
      if (authUrl) {
        urlShown = true
        on.prompt(authUrl)
      }
    }
    const auth = messages.find((m) => m.id === 1)
    if (auth) {
      on.done(auth.error ? { ok: false, error: auth.error.message ?? 'Authentication failed' } : { ok: true })
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
}
