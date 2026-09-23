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

import type { WirePromptOrigin } from '@/app/_authed/(agent)/_lib/prompt-origin'
import { slug } from '@/app/_authed/(server)/_server/types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import {
  editTurnLocalImpl,
  ensureLocalSessionImpl,
  findTargetSessionImpl,
  forgetLocalSessionImpl,
  promptLocalImpl,
  stopLocalSessionProcessImpl,
  tabSessions,
} from './acp-impl'
import { readPersistedSession, writePersistedUsage } from './acp-session-store'
import { AttachmentRejected, saveAttachment } from './attachment-store'
import { flushSessionEvents, readSessionEvents } from './session-event-store'

// The browser must not be able to say who a message is from — the name is
// resolved server-side, from the session, in promptLocalImpl.
//
// This is a compile-time assertion on purpose, because the guarantee is
// structural: there is no runtime check to exercise, only a wire that has
// nowhere to put a name. `@ts-expect-error` inverts it into something that
// FAILS — in the ordinary typecheck gate — the day someone widens
// WirePromptOrigin back to include `{ kind: 'message' }`, which is precisely
// how this hole would reopen. A comment could not do that.
// @ts-expect-error a client-stated sender must not typecheck
const _forgedOrigin: WirePromptOrigin = { kind: 'message', sender: 'somebody-else' }
void _forgedOrigin

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
function seedMockConnection(selection: AgentSelection, options: { canLoad?: boolean; forkable?: boolean } = {}): void {
  const connection = {
    newSession: async () => ({ sessionId: `acp-session-${crypto.randomUUID()}` }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    // Answered only when the store entry below advertises `forkSupported` — the
    // engine refuses before reaching a connection that did not. A fresh id, so
    // the fork is a distinct session, exactly as the real bridge returns.
    unstable_forkSession: async () => ({ sessionId: `acp-fork-${crypto.randomUUID()}` }),
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
    forkSupported: options.forkable ?? false,
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
  const tabKey = `acp-test-tab-${crypto.randomUUID()}`

  // Mount #1: genuinely creates the session, exactly like the real first mount.
  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  assert.equal(first.created, true, 'the session is genuinely new on the first call')

  // Mount #2: same tab, no message has ever been sent through either mount --
  // this is the scenario that used to corrupt createdRef. Whichever mount
  // goes on to call deliver() must still see this as the session's first
  // message, since nothing has been prompted yet.
  const second = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  assert.equal(
    second.created,
    true,
    'a second mount for a still-untouched tab must also see it as new -- nothing has been prompted yet',
  )
})

test('once a message is delivered, a later ensureLocalSession call for the same tab reports created:false', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection)
  const tabKey = `acp-test-tab-${crypto.randomUUID()}`

  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  assert.equal(opened.created, true)

  await promptLocalImpl({ sessionId: opened.sessionId, text: 'hello', queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })

  const resumed = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
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
  const tabKey = `agent-test-tab-${crypto.randomUUID()}`

  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })

  assert.deepEqual(
    await readPersistedSession(tabKey),
    { id: opened.sessionId, prompted: false },
    'the pointer must exist before the first prompt — that window is the whole first turn',
  )
})

test('a restart before the first turn ends resumes the same session instead of creating a rival', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { canLoad: true })
  const tabKey = `agent-test-tab-${crypto.randomUUID()}`

  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  await promptLocalImpl({ sessionId: first.sessionId, text: 'implement the fix', queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  forgetInMemorySession(tabKey)

  const afterRestart = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })

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
  const tabKey = `agent-test-tab-${crypto.randomUUID()}`

  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  forgetInMemorySession(tabKey)

  const afterRestart = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })

  assert.equal(afterRestart.sessionId, first.sessionId, 'still one session')
  assert.equal(afterRestart.created, true, 'nothing was ever sent to it, so it has no context yet')
})

// The requirement: a pointer can go stale, and the replacement
// must never start work without knowing what the work is.
test('a dead pointer falls back to a fresh session that still gets the full context', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { canLoad: false })
  const tabKey = `agent-test-tab-${crypto.randomUUID()}`

  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  await promptLocalImpl({ sessionId: first.sessionId, text: 'implement the fix', queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(await readPersistedSession(tabKey), { id: first.sessionId, prompted: true })

  // The pointer survives, the session does not.
  forgetInMemorySession(tabKey)

  const replacement = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })

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
  const tabKey = `agent-test-tab-${crypto.randomUUID()}`

  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  forgetInMemorySession(tabKey)

  // Live, just not in this process's map any more: the durable pointer is what
  // finds it, which is the whole point of the lookup being able to read it.
  assert.deepEqual(await findTargetSessionImpl({ baseKey: tabKey }), { sessionId: opened.sessionId })

  // A pointer to a session that no longer exists is not a target — prompting
  // it would send the message into nothing.
  assert.equal(await findTargetSessionImpl({ baseKey: `agent-test-tab-${crypto.randomUUID()}` }), null)
})

// ── unload-session primitive ──────────────────────────────────────────────
//
// stopLocalSessionProcessImpl is the mechanism the new "unload" send-message
// action delegates to. Unlike forgetInMemorySession (a test-only stand-in for
// a server restart, which never touches agent-client at all), this function
// actually calls agentClient.deleteSession -- the real kill/close path -- so
// these tests are the only place that mechanism itself is exercised, not just
// the in-memory bookkeeping around it.

test('stopLocalSessionProcessImpl drops the in-memory pointer but keeps the durable one', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { canLoad: true })
  const tabKey = `resume-test-tab-${crypto.randomUUID()}`

  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  await stopLocalSessionProcessImpl(tabKey)

  assert.equal(tabSessions.has(tabKey), false, 'the live pointer is gone -- nothing to route a message to yet')
  assert.deepEqual(
    await readPersistedSession(tabKey),
    { id: opened.sessionId, prompted: false },
    'unload must not touch the durable pointer -- that is the whole difference from forgetLocalSessionImpl',
  )
})

test('a message after unload reattaches to the SAME session instead of starting a new one', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { canLoad: true })
  const tabKey = `resume-test-tab-${crypto.randomUUID()}`

  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  await promptLocalImpl({ sessionId: first.sessionId, text: 'implement the fix', queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await stopLocalSessionProcessImpl(tabKey)

  const afterUnload = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })

  assert.equal(
    afterUnload.sessionId,
    first.sessionId,
    'a queued message must reload the unloaded session, not spawn a rival for the same tab',
  )
  assert.equal(afterUnload.created, false, 'the reattached session already has its history -- it is not new')
})

// The idle reaper's unload, then the next message reopening the session under
// the same id: a chat's stream opened before the unload must be told it ended,
// or it stays attached to the dropped record and the reader sees nothing of
// the work the reopened session goes on to do.
test('an unload ends the streams reading the session, so a reader reconnects to the reopened one', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { canLoad: true })
  const tabKey = `resume-test-tab-${crypto.randomUUID()}`

  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  let ended = 0
  agentClient.subscribe(first.sessionId, () => {}, { onEnd: () => (ended += 1) })
  await stopLocalSessionProcessImpl(tabKey)
  assert.equal(ended, 1, 'the stream is told its session went')

  const reopened = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  assert.equal(reopened.sessionId, first.sessionId, 'the same id comes back -- which is why the old stream cannot tell')
})

// ── forget-session primitive ──────────────────────────────────────────────
//
// forgetLocalSessionImpl is the mechanism the new "delete" send-message action
// delegates to for tearing down the live process and the
// durable pointer. This is its opposite twin to stopLocalSessionProcessImpl
// above: same live-process teardown, but the durable pointer must NOT survive.

test('forgetLocalSessionImpl drops the durable pointer too -- unlike stopLocalSessionProcessImpl', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { canLoad: true })
  const tabKey = `close-test-tab-${crypto.randomUUID()}`

  await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  await forgetLocalSessionImpl(tabKey)

  assert.equal(tabSessions.has(tabKey), false, 'the live pointer is gone')
  assert.equal(
    await readPersistedSession(tabKey),
    null,
    'delete must drop the durable pointer -- a later restart must not resurrect this session',
  )
})

// ── edit recreates, it does not branch ──────────────────────────────────────
//
// ACP gives no way to rewind a session in place (even the native harness forks
// to a fresh id), so an edit is a fork the tab adopts. The pre-edit session
// must then be torn down: left alive it is an orphaned process no tab points
// at, and the idle reaper is opt-in and off by default, so nothing else
// reliably reclaims it.

test('committing an edit recreates the session and deletes the pre-edit one, leaving no orphan', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { forkable: true })
  const tabKey = `edit-test-tab-${crypto.randomUUID()}`

  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  await promptLocalImpl({
    sessionId: opened.sessionId,
    text: 'first message',
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })

  const events = agentClient.getSessionEvents(opened.sessionId) ?? []
  const eventIndex = events.findIndex((event) => event.kind === 'user')
  assert.ok(eventIndex >= 0, 'the delivered message is a user turn in the log')

  const result = await editTurnLocalImpl({
    tabKey,
    sessionId: opened.sessionId,
    eventIndex,
    edits: [{ index: 0, text: 'edited message' }],
  })
  assert.ok(result, 'the edit committed')
  assert.notEqual(result.sessionId, opened.sessionId, 'the edit recreated the session, it did not edit in place')
  assert.equal(tabSessions.get(tabKey)?.id, result.sessionId, 'the tab now points at the recreated session')

  const liveIds = agentClient.listSessions().map((meta) => meta.id)
  assert.equal(liveIds.includes(opened.sessionId), false, 'the pre-edit session was deleted, not left orphaned')
  assert.equal(liveIds.includes(result.sessionId), true, 'the recreated session is the live one')
})

// A picture goes as a stored id, resolved here against the tab's own
// conversation: the name the transcript shows comes from the store, an id from
// anywhere else refuses the send, and an edit re-sends the pictures with the
// messages they came with.
test('a sent picture is recorded from the store, and an edit carries it into the new session', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { forkable: true })
  const tabKey = `picture-test-tab-${crypto.randomUUID()}`
  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  const stored = await saveAttachment({ sessionKey: tabKey, name: 'shot.png', mimeType: 'image/png', data: 'AAAA' })

  await promptLocalImpl({
    sessionId: opened.sessionId,
    text: 'look at this',
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
    attachments: [stored.id],
  })
  const sent = (agentClient.getSessionEvents(opened.sessionId) ?? []).findIndex((event) => event.kind === 'user')
  const delivered = agentClient.getSessionEvents(opened.sessionId)?.[sent]
  assert.ok(delivered?.kind === 'user')
  assert.deepEqual(delivered.attachments, [{ id: stored.id, name: 'shot.png', mimeType: 'image/png', message: 0 }])
  assert.equal(delivered.text.includes(stored.id), false, 'the reference is beside the words, never in them')

  const result = await editTurnLocalImpl({
    tabKey,
    sessionId: opened.sessionId,
    eventIndex: sent,
    edits: [{ index: 0, text: 'look at this instead' }],
  })
  assert.ok(result)
  const resent = (agentClient.getSessionEvents(result.sessionId) ?? []).filter((event) => event.kind === 'user').at(-1)
  assert.ok(resent?.kind === 'user')
  assert.deepEqual(resent.attachments, delivered.attachments)
})

test("a send naming another conversation's picture is refused before anything is delivered", async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection)
  const tabKey = `picture-test-tab-${crypto.randomUUID()}`
  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  const foreign = await saveAttachment({
    sessionKey: `someone-else-${crypto.randomUUID()}`,
    name: 'theirs.png',
    mimeType: 'image/png',
    data: 'AAAA',
  })
  await assert.rejects(
    promptLocalImpl({
      sessionId: opened.sessionId,
      text: 'look',
      queue: 'wait',
      origin: { kind: 'message', sender: 'Reader' },
      attachments: [foreign.id],
    }),
    AttachmentRejected,
  )
  assert.equal(
    (agentClient.getSessionEvents(opened.sessionId) ?? []).some((event) => event.kind === 'user'),
    false,
    'nothing went out',
  )
  assert.equal((await readPersistedSession(tabKey))?.prompted, false, 'and the session is not marked as spoken to')
})

test('a thread keeps persisting its transcript after an edit is committed', async () => {
  // The round-trip constraint: what is re-sent has to survive a
  // restart, and AgentSessionEvent is the only source a rebuild has. So the
  // question is not whether the edit looks right on screen -- the process holds
  // that either way -- but whether anything reaches the table afterwards.
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { forkable: true })
  const tabKey = `edit-persist-tab-${crypto.randomUUID()}`

  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  await promptLocalImpl({
    sessionId: opened.sessionId,
    text: 'first message',
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  await flushSessionEvents()

  // THE PRECONDITION. Persistence has to be working before the commit, or
  // "nothing afterwards" says nothing about the commit.
  const before = await readSessionEvents(tabKey)
  assert.ok(before.length > 0, 'precondition: this thread persists its transcript before any edit')

  const events = agentClient.getSessionEvents(opened.sessionId) ?? []
  const eventIndex = events.findIndex((event) => event.kind === 'user')
  assert.ok(eventIndex >= 0)
  const result = await editTurnLocalImpl({
    tabKey,
    sessionId: opened.sessionId,
    eventIndex,
    edits: [{ index: 0, text: 'edited message' }],
  })
  assert.ok(result)

  // An ORDINARY turn after the commit, because that is the half that showed the
  // regression is not confined to the edited turn: the tab is pointed at the
  // recreated session from here on, so everything it emits goes wherever that
  // session's events go.
  await promptLocalImpl({
    sessionId: result.sessionId,
    text: 'an ordinary message after the commit',
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  await flushSessionEvents()

  const after = await readSessionEvents(tabKey)
  assert.ok(
    after.length > before.length,
    `the transcript kept growing after the commit (had ${before.length}, now ${after.length})`,
  )

  // AND IT HAS TO BE THE RIGHT TRANSCRIPT, not merely a growing one. The fork
  // is trimmed at the edited turn, so the rows that described the pre-edit turn
  // are no longer part of this conversation -- a replay carrying both would
  // show the reader a turn they edited away, followed by the edit.
  const text = JSON.stringify(after)
  assert.ok(text.includes('edited message'), 'the re-sent turn is in the persisted transcript')
  assert.ok(text.includes('an ordinary message after the commit'), 'and so is the turn after it')
  assert.ok(!text.includes('first message'), 'while the turn the edit replaced is gone from it')
})

// ── contextUsage ────────────────────────────────────────────────────────
//
// The composer seeds its ring from this field so it shows a figure the
// instant it mounts, instead of waiting for the connection's first live
// 'usage' event -- resolved the same live-or-last-known way host.ts's own
// listSessions resolves it (see currentContextUsage).

test('a fresh, never-prompted session has contextUsage: null -- nothing has ever been reported', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection)
  const tabKey = `dock-test-tab-${crypto.randomUUID()}`

  const opened = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })

  assert.equal(opened.contextUsage, null)
})

// Reattaching an unloaded session (see stopLocalSessionProcessImpl above) goes
// through the SAME resume path a real restart does, which restores the
// session's last persisted usage into agent-client BEFORE ensureLocalSession
// returns -- so by the time the composer ever sees it, the reading is live
// again, never a last-known/`asOf`-marked one. This is the reason a stale,
// dimmed ring cannot come from this call: reopening a thread revives it.
test('reattaching an unloaded session restores its last usage live -- never as a stale (asOf) reading', async () => {
  const { nodeId, selection } = await freshAgentNode()
  seedMockConnection(selection, { canLoad: true })
  const tabKey = `dock-test-tab-${crypto.randomUUID()}`

  const first = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })
  await promptLocalImpl({ sessionId: first.sessionId, text: 'implement the fix', queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await writePersistedUsage(first.sessionId, { used: 8_000, size: 200_000 })
  await stopLocalSessionProcessImpl(tabKey)

  const reattached = await ensureLocalSessionImpl({ agentNodeId: nodeId, tabKey })

  assert.deepEqual(
    reattached.contextUsage,
    { usedTokens: 8_000, contextLimit: 200_000 },
    // The tokens come back and there is no asOf: resuming makes the session
    // live again before this returns, which is what this test is for.
    //
    // The window comes back too. Under the current window rule a bridged reported
    // size is relayed when the reading does not contradict it (8k against 200k
    // does not), and the restore path runs the same normalizeUsage the live
    // path does -- so the persisted 200_000 is shown here exactly as a fresh
    // live reading of it would be, rather than withheld as it once was.
    'the persisted tokens and the reported window both come back live (no asOf)',
  )
})
