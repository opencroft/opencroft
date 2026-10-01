import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentClient } from '../agent-client'
import { HARNESS_ADAPTERS } from '../harness-adapters'
import type { AgentSelection, ChatEvent } from '../types'

// Drives the client end to end over a real ACP connection against
// fake-claude-agent.mjs, a fake that keeps claude-agent-acp's contract as read
// from its source. Over the wire rather than through a mock connection, so the
// ACP SDK's own encoding and schema checks sit between the two sides.

const FAKE_AGENT = fileURLToPath(new URL('./fake-claude-agent.mjs', import.meta.url))

export interface LoggedRequest {
  method: string
  params: Record<string, unknown>
}

export interface FakeClaudeHarness {
  client: ReturnType<typeof createAgentClient>
  cwd: string
  requests: () => LoggedRequest[]
  events: Array<{ sessionId: string; event: ChatEvent }>
  printed: string[]
}

export function claudeSelection(cwd: string, apiKey = 'test-key'): AgentSelection {
  return {
    providerId: 'zai',
    adapterId: 'claude',
    model: 'glm-5.3-flash[1m]',
    apiKey,
    cwd,
  }
}

// `mode` is the fake's FAKE_AGENT_MODE (see fake-claude-agent.mjs).
export async function withFakeClaude(mode: string, run: (h: FakeClaudeHarness) => Promise<void>): Promise<void> {
  const adapter = HARNESS_ADAPTERS.find((entry) => entry.id === 'claude')
  assert.ok(adapter)
  const saved = { command: adapter.command, args: adapter.args }
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  const logFile = join(dir, 'requests.jsonl')
  const cwd = join(dir, 'work')
  mkdirSync(cwd)
  const savedEnv = {
    log: process.env.FAKE_AGENT_LOG,
    mode: process.env.FAKE_AGENT_MODE,
    state: process.env.FAKE_AGENT_STATE,
  }
  process.env.FAKE_AGENT_LOG = logFile
  process.env.FAKE_AGENT_MODE = mode
  process.env.FAKE_AGENT_STATE = join(dir, 'transcripts.json')
  adapter.command = process.execPath
  adapter.args = [FAKE_AGENT]
  const printed: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    printed.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '))
  }
  const events: Array<{ sessionId: string; event: ChatEvent }> = []
  const client = createAgentClient({
    onEvent: (sessionId, event) => events.push({ sessionId, event }),
    loadMcpServers: async () => [],
  })
  try {
    await run({
      client,
      cwd,
      requests: () =>
        existsSync(logFile)
          ? readFileSync(logFile, 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as LoggedRequest)
          : [],
      events,
      printed,
    })
  } finally {
    await client.reset()
    console.error = originalError
    adapter.command = saved.command
    adapter.args = saved.args
    if (savedEnv.log === undefined) delete process.env.FAKE_AGENT_LOG
    else process.env.FAKE_AGENT_LOG = savedEnv.log
    if (savedEnv.mode === undefined) delete process.env.FAKE_AGENT_MODE
    else process.env.FAKE_AGENT_MODE = savedEnv.mode
    if (savedEnv.state === undefined) delete process.env.FAKE_AGENT_STATE
    else process.env.FAKE_AGENT_STATE = savedEnv.state
    rmSync(dir, { recursive: true, force: true })
  }
}

// The first turn_end or error a session emits from `from` on: how a turn ends.
export async function turnOutcome(
  events: Array<{ sessionId: string; event: ChatEvent }>,
  sessionId: string,
  from = 0,
): Promise<ChatEvent> {
  for (let waited = 0; waited < 5000; waited += 10) {
    const hit = events
      .slice(from)
      .find(
        (entry) => entry.sessionId === sessionId && (entry.event.kind === 'turn_end' || entry.event.kind === 'error'),
      )
    if (hit) {
      return hit.event
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`session ${sessionId} never ended its turn`)
}
