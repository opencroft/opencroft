// A stand-in for codex-acp 1.13.1, reduced to the contract the Codex base
// integration depends on (read from its source: CodexAuthMethod.ts,
// CodexAcpServer.ts ensureAuthenticated, CodexAcpClient.ts MCP mapping):
//  - initialize advertises `api-key` and `gateway` auth and
//    `mcpCapabilities {http: true, sse: false}`;
//  - session/new refuses until `authenticate` succeeded, and refuses the whole
//    request over a single `sse` MCP server.
// Deliberately careless with the key, the way a real harness may be: it prints
// it to stderr at start and echoes the Authorization header in a rejection —
// the client must keep both out of every log, error and event.
//
// FAKE_AGENT_LOG: file that receives one JSON line per request.
// FAKE_AGENT_MODE: '' | 'reject-auth' | 'no-gateway' | 'open' (no auth needed).
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'

const mode = process.env.FAKE_AGENT_MODE ?? ''
const log = (entry) => {
  if (process.env.FAKE_AGENT_LOG) {
    appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify(entry)}\n`)
  }
}
process.stderr.write(`fake codex-acp starting, CODEX_API_KEY=${process.env.CODEX_API_KEY ?? ''}\n`)

let authenticated = mode === 'open'
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(
  () => ({
    async initialize(params) {
      log({
        method: 'initialize',
        params,
        cwd: process.cwd(),
        env: {
          CODEX_HOME: process.env.CODEX_HOME ?? null,
          CODEX_CONFIG: process.env.CODEX_CONFIG ?? null,
          NO_BROWSER: process.env.NO_BROWSER ?? null,
        },
      })
      const authMethods = [{ id: 'api-key', name: 'API Key' }]
      if (mode !== 'no-gateway') {
        authMethods.push({ id: 'gateway', name: 'Custom model gateway' })
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false, mcpCapabilities: { http: true, sse: false } },
        authMethods,
      }
    },
    async authenticate(params) {
      log({ method: 'authenticate', params })
      if (mode === 'reject-auth') {
        throw RequestError.invalidParams(
          { header: params._meta?.gateway?.headers?.Authorization },
          `gateway rejected credentials ${params._meta?.gateway?.headers?.Authorization}`,
        )
      }
      authenticated = true
      return {}
    },
    async newSession(params) {
      log({ method: 'session/new', params })
      if (!authenticated) {
        throw RequestError.authRequired()
      }
      if (params.mcpServers.some((server) => server.type === 'sse')) {
        throw RequestError.invalidRequest(undefined, 'SSE MCP servers are not supported')
      }
      return { sessionId: `fake-${process.pid}` }
    },
    async prompt() {
      return { stopReason: 'end_turn' }
    },
    async cancel() {},
  }),
  stream,
)
