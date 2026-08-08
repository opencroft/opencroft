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
// the same way repeated mounts and the first real send would, against the
// real database (embedded PGlite by default) — see @opencroft/db's test-env
// for how this stays off the shared dev/production database.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentConnection } from 'agent-client/connection'
import { buildSpawnConfig } from 'agent-client/resolve'
import type { AgentSelection } from 'agent-client/types'

import { slug } from '@/app/_authed/(server)/_server/types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { ensureLocalSessionImpl, findTargetSessionImpl, promptLocalImpl, tabSessions } from './acp-impl'
import { readPersistedSession } from './acp-session-store'

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
function seedMockConnection(selection: AgentSelection, options: { canLoad?: boolean } = {}): void {
  const connection = {
    newSession: async () => ({ sessionId: `acp-session-${crypto.randomUUID()}` }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    // `canLoad: false` is an agent that cannot bring a session back — the
    // pointer still names it, but nothing can be resumed from it. The store
    // entry below advertises the capability; this is what actually performs it.
    loadSession: async () => {
      if (options.canLoad !== true) {
        throw new Error('session cannot be loaded')
      }
      return {}
    },
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection
  const key = JSON.stringify(buildSpawnConfig(selection))
  acpStore().connections.set(key, {
    connection,
    lastSessionId: null,
    loadSession: options.canLoad ?? false,
    initialized: Promise.resolve(),
  })
}

// Everything this process remembers about open tabs is gone after a restart;
// the durable pointer is all that is left. Dropping the entry reproduces that
// without restarting anything.
function forgetInMemorySession(tabKey: string): void {
  tabSessions.delete(tabKey)
}

async function freshAgentNode(): Promise<{ nodeId: string; selection: AgentSelection }> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const spaceSlug = `acp-acp-impl-${crypto.randomUUID()}`
  // Unique per call: openLocalSession resolves an agent by node id across every
  // space, so a shared id would hand this test the FIRST test's agent — and so
  // the first test's mock connection, silently, with different capabilities.
  const nodeId = `agent-${crypto.randomUUID()}`
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

// ── surviving a restart ───────────────────────────────
//
// A dispatched session used to exist only in this process's memory until its
// FIRST TURN FINISHED — which for a real task is the whole time the agent is
// working. Losing that memory meant the next delivery for the same key created
// a second session, and two agents implemented the same task.

test('a session is durable the moment it is created, before anything is prompted', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection)
  const tabKey = `agent:agent:test:${crypto.randomUUID()}`

  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })

  assert.deepEqual(
    await readPersistedSession(tabKey),
    { id: opened.sessionId, prompted: false },
    'the pointer must exist before the first prompt — that window is the whole first turn',
  )
})

test('a restart before the first turn ends resumes the same session instead of creating a rival', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { canLoad: true })
  const tabKey = `agent:agent:test:${crypto.randomUUID()}`

  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })
  await promptLocalImpl({ sessionId: first.sessionId, text: 'implement the fix' })
  forgetInMemorySession(tabKey)

  const afterRestart = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })

  assert.equal(
    afterRestart.sessionId,
    first.sessionId,
    'the second dispatch must land in the session already doing the work',
  )
  assert.equal(afterRestart.created, false, 'that session already has its context — restating the task would be noise')
})

test('a restart before the first prompt resumes the same session and still briefs it', async () => {
  // Created, then orphaned before anything was sent. One session, and it must
  // still be told what it is for.
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { canLoad: true })
  const tabKey = `agent:agent:test:${crypto.randomUUID()}`

  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })
  forgetInMemorySession(tabKey)

  const afterRestart = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })

  assert.equal(afterRestart.sessionId, first.sessionId, 'still one session')
  assert.equal(afterRestart.created, true, 'nothing was ever sent to it, so it has no context yet')
})

// The requirement: a pointer can go stale, and the replacement
// must never start work without knowing what the work is.
test('a dead pointer falls back to a fresh session that still gets the full context', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { canLoad: false })
  const tabKey = `agent:agent:test:${crypto.randomUUID()}`

  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })
  await promptLocalImpl({ sessionId: first.sessionId, text: 'implement the fix' })
  assert.deepEqual(await readPersistedSession(tabKey), { id: first.sessionId, prompted: true })

  // The pointer survives, the session does not.
  forgetInMemorySession(tabKey)

  const replacement = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })

  assert.notEqual(replacement.sessionId, first.sessionId, 'the dead session cannot be resumed, so this is a new one')
  assert.equal(
    replacement.created,
    true,
    'a replacement has none of the dead session history — it must be briefed, never dropped into a context-less void',
  )
  assert.deepEqual(
    await readPersistedSession(tabKey),
    { id: replacement.sessionId, prompted: false },
    'the pointer now names the replacement, and records that it has not been spoken to yet',
  )
})

test('the durable pointer is only offered as a target while its session is live', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection)
  const tabKey = `agent:agent:test:${crypto.randomUUID()}`

  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, jobNodeId: 'job-1', tabKey })
  forgetInMemorySession(tabKey)

  // Live, just not in this process's map any more: the durable pointer is what
  // finds it, which is the whole point of the lookup being able to read it.
  assert.deepEqual(await findTargetSessionImpl({ baseKey: tabKey }), { sessionId: opened.sessionId })

  // A pointer to a session that no longer exists is not a target — prompting
  // it would send the message into nothing.
  assert.equal(await findTargetSessionImpl({ baseKey: `agent:agent:test:${crypto.randomUUID()}` }), null)
})
