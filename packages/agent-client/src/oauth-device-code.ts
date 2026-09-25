// The device-code sign-in driver (codex-acp): a plain ACP exchange.
// `authenticate` makes the agent ask the client, through a URL-mode
// `elicitation/create`, to show a verification URL and a one-time code; the
// request returns once the user has entered the code there, or the attempt
// failed. Nothing is typed back into the process.

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import {
  type Client,
  ClientSideConnection,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

import { errorMessage } from './errors'
import type { OauthLoginResult } from './oauth-login'

export interface DeviceCodePrompt {
  verificationUrl: string
  // Null when the message carries no recognisable code; the message is still
  // shown whole.
  userCode: string | null
  message: string
}

// Exported for tests: the one-time code in a device-code elicitation message.
// codex-acp 1.13.1 words it "Sign in to ChatGPT and enter this code: <code>";
// the code is whatever follows the last colon.
export function extractUserCode(message: string): string | null {
  const match = /:\s*(\S+)\s*$/.exec(message)
  return match ? match[1] : null
}

// The link is rendered as a link to click, so anything but http(s) is refused.
function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

export function driveDeviceCodeLogin(
  child: ChildProcessWithoutNullStreams,
  spec: { methodId: string; label: string },
  on: { prompt: (prompt: DeviceCodePrompt) => void; done: (result: OauthLoginResult) => void },
): void {
  const client: Client = {
    async requestPermission() {
      return { outcome: { outcome: 'cancelled' } }
    },
    async sessionUpdate() {},
    // Accepting only says the user was shown the link: the agent then waits
    // for the sign-in to finish on its side, and its `authenticate` answer
    // settles the login.
    async createElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
      const url = request.mode === 'url' ? (request as { url?: unknown }).url : undefined
      if (typeof url !== 'string' || !isWebUrl(url)) {
        return { action: 'decline' }
      }
      on.prompt({ verificationUrl: url, userCode: extractUserCode(request.message), message: request.message })
      return { action: 'accept' }
    },
    async completeElicitation() {},
  }
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
  )
  const run = async (): Promise<OauthLoginResult> => {
    const init = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, elicitation: { url: {} } },
    })
    if (!(init.authMethods ?? []).some((method) => method.id === spec.methodId)) {
      return {
        ok: false,
        error: `${spec.label} does not offer the '${spec.methodId}' sign-in, so this login cannot run.`,
      }
    }
    try {
      await connection.authenticate({ methodId: spec.methodId })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `Sign-in did not complete: ${errorMessage(error)}` }
    }
  }
  run().then(on.done, (error: unknown) =>
    on.done({ ok: false, error: `Failed to start the sign-in: ${errorMessage(error)}` }),
  )
}
