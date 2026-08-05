// A chat's first real message could land with `isNewSession: false` even
// though the session was genuinely just created, dropping the session-scoped
// envelope content (task context, instructions, title request).
//
// use-acp-session.ts tracks "was this session just created" in a per-mount ref
// (`createdRef`), set from `ensureLocalSession`'s `created` flag. Before this
// fix, `created` answered a question about the underlying ACP session object
// ("did THIS call just instantiate it"), not about the tab ("has any message
// ever been delivered into this session"). Those diverge the moment
// `useAcpSession` mounts more than once for the same tabKey before the first
// message goes out — exactly what the module's own `ensureInFlight` comment
// says happens ("the inspector fires several [calls] on mount/focus"): a
// second mount for a never-prompted tab used to be told the session already
// existed, even though nothing had been sent yet.
//
// The fix moves the signal from "did I just create it" to "has this session
// ever been prompted" (TabSession.everPrompted, flipped in promptLocalImpl),
// which is a fact about the session, not about which call happened to
// observe it first. These tests drive ensureLocalSessionImpl/promptLocalImpl
// the same way repeated mounts and the first real send would.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentConnection } from 'agent-client/connection'
import { buildSpawnConfig } from 'agent-client/resolve'
import type { AgentSelection } from 'agent-client/types'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { slug } from '@/app/_authed/(server)/_server/types'

import { ensureLocalSessionImpl, promptLocalImpl } from './acp-impl'

interface AcpStoreShape {
  connections: Map<string, unknown>
}

function acpStore(): AcpStoreShape {
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  return store
}

// Seeds a mock connection under the exact spawn-config key `openLocalSession`
// will derive for this agent, so `agentClient.createSession` reuses it instead
// of spawning a real process — same seam agent-client's own tests use.
function seedMockConnection(selection: AgentSelection): void {
  const connection = {
    newSession: async () => ({ sessionId: `acp-session-${crypto.randomUUID()}` }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection
  const key = JSON.stringify(buildSpawnConfig(selection))
  acpStore().connections.set(key, {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
}

async function freshAgentNode(): Promise<{ nodeId: string; selection: AgentSelection }> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const spaceSlug = `acp-acp-impl-${crypto.randomUUID()}`
  const nodeId = 'agent-1'
  const agentName = `ACP Test Agent ${crypto.randomUUID()}`
  await registry.create(spaceSlug, spaceSlug, {
    nodes: [
      {
        id: nodeId,
        type: 'agent',
        position: { x: 0, y: 0 },
        data: { name: agentName, providerId: 'test-provider', adapterId: 'openclaw', model: 'test-model' },
      },
    ],
    edges: [],
  })
  const workspaceSlug = slug(agentName) || nodeId
  const cwd = join(process.cwd(), 'data', 'agent-workspace', workspaceSlug)
  await mkdir(cwd, { recursive: true })
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd,
    sessionKey: '',
    mcpIdentity: workspaceSlug,
  }
  return { nodeId, selection }
}

test('a second ensureLocalSession call for the same never-prompted tab still reports created:true', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection)
  const tabKey = `agent:acp:test:${crypto.randomUUID()}`

  // Mount #1: genuinely creates the session, exactly like the real first mount.
  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })
  assert.equal(first.created, true, 'the session is genuinely new on the first call')

  // Mount #2: same tab, no message has ever been sent through either mount --
  // this is the scenario that used to corrupt createdRef. Whichever mount
  // goes on to call deliver() must still see this as the session's first
  // message, since nothing has been prompted yet.
  const second = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })
  assert.equal(
    second.created,
    true,
    'a second mount for a still-untouched tab must also see it as new -- nothing has been prompted yet',
  )
})

test('once a message is delivered, a later ensureLocalSession call for the same tab reports created:false', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection)
  const tabKey = `agent:acp:test:${crypto.randomUUID()}`

  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })
  assert.equal(opened.created, true)

  await promptLocalImpl({ sessionId: opened.sessionId, text: 'hello' })

  const resumed = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })
  assert.equal(resumed.created, false, 'a session that already received a message is never "new" again')
})
