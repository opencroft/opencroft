// Plain (non-`createServerFn`) session machinery, plus the tab->session state
// every caller shares.
//
// This lives apart from acp.ts on purpose, and the separation is load-bearing
// for the CLIENT BUILD, not just for tidiness. acp.ts is imported directly by
// browser components (the group-chat thread route and the chat hooks), so it sits
// in the client graph on every page. It survives there only because every one
// of its exports is a `createServerFn`: the client build replaces each with an
// RPC stub, which leaves acp.ts's own top-level imports unused and lets them —
// agentClient, and `esbuild`/`ssh2`/`@tailwindcss/node` in its dependency tail —
// be dropped from the browser bundle.
//
// A plain exported function has no stub, so adding one to acp.ts keeps that
// whole import tail alive and ships bare Node specifiers to the browser, which
// fails to link the module graph and leaves the canvas stuck loading. Server-side
// callers that must avoid nesting one `createServerFn` inside another's handler
// (see deliverToSendMessageNode) therefore import from HERE, and acp.ts keeps
// its all-`createServerFn` export list intact.
//
// The rule this file exists to hold: nothing under `_components`, `_lib`,
// `_canvas`, `_shell` — anything reachable from `'use client'` — may import this
// module. Making an import lazy or SSR-guarding it does not help; only
// reachability matters.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { getSessionUser } from '@opencroft/auth/server'
import { getRequest } from '@tanstack/react-start/server'
import { supportsMidTurnInput } from 'agent-client'
import { usableContextWindow } from 'agent-client/context-window'
import { rebuildDelivery, splitDelivery } from 'agent-client/queue-tags'
import type { AgentSelection, Presence, PromptOrigin, QueueMode, SessionMeta } from 'agent-client/types'

import type { AuthoredRecordsWindow } from '@/app/_authed/(agent)/_lib/acp-stream'
import type { PromptOriginInput } from '@/app/_authed/(agent)/_lib/prompt-origin'
import {
  deletePersistedConfigOptions,
  deletePersistedPresence,
  deletePersistedSession,
  readLastKnownUsage,
  readPersistedConfigOptions,
  readPersistedSession,
  readPersistedUsage,
  writePersistedPresence,
  writePersistedSession,
} from '@/app/_authed/(agent)/_server/acp-session-store'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { withAuthors } from '@/app/_authed/(agent)/_server/attach-authors'
import { queueStore } from '@/app/_authed/(agent)/_server/queue-store'
import {
  appendSessionEvent,
  clearSessionEvents,
  readSessionEvents,
} from '@/app/_authed/(agent)/_server/session-event-store'
import {
  forceBypassMode,
  installYoloModeEnforcement,
  modeLockedByYolo,
} from '@/app/_authed/(agent)/_server/yolo-mode-enforcement'
import { splitEnvelope, stripDeliveryStamp } from '@/app/_authed/(agent)/_shared/message-envelope'
import { type ContextUsage, toContextUsage } from '@/app/_authed/(extension-runtime)/_server/session-context-usage'
import { slug } from '@/app/_authed/(server)/_server/types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { authorForPerson } from '@/app/_server/message-author'
import { secrets } from '@/server/secrets'

interface AgentNodeData {
  name?: string
  providerId?: string
  adapterId?: string
  model?: string
  apiKeySecret?: string
  defaultModeId?: string
  baseUrl?: string
  systemPrompt?: string
  reasoningEffort?: string
  temperature?: number
  contextWindow?: number
  containerName?: string
}

export interface OpenedSession {
  sessionId: string
  canFork: boolean
  canSteer: boolean
  // The adapter this session runs. Carried to the client because a session mode
  // id only means something against the adapter that advertised it — the client
  // needs it to classify modes (see agent-client's session-modes), and has no
  // other route to it.
  adapterId: string
  // Whether this session has never had a prompt delivered into it yet — the
  // one authoritative signal for whether the caller's next message is the
  // session's first. NOT "did this call just create the session object":
  // ensureLocalSessionImpl is idempotent per tab and can be called more than
  // once (mount, remount, a second surface warming the same tab) before the
  // user ever sends anything, so a later call for the same still-untouched
  // tab must answer `true` too, not just the one call that happened to spin
  // the session up. Callers key session-scoped envelope content (task
  // context, instructions) off this instead of inferring it themselves — see
  // the message-envelope module.
  created: boolean
  // What this session currently holds, resolved the same way host.ts resolves
  // it for listSessions: a live reading if the session has a process right
  // now, else the last-known reading persisted before it went offline (see
  // ContextUsage's own `asOf`), else null if nothing was ever reported. Lets
  // the composer show a figure the moment it mounts instead of waiting for
  // this connection's first live 'usage' event.
  contextUsage: ContextUsage | null
}

export interface TabSession {
  id: string
  // Whether this tab's agent can fork its history (the engine's resolution:
  // the native harness's own store, or an advertised `session/fork`).
  canFork: boolean
  // Whether this tab's agent accepts mid-turn prompts as live-turn input
  // (adapter-declared; see agent-client's supportsMidTurnInput).
  canSteer: boolean
  // Whether a prompt has ever been delivered into this session. Session
  // creation and "has the first message gone out yet" are different events —
  // ensureLocalSessionImpl can be (and routinely is) called more than once for
  // the same tab before the user's first message is actually sent, so `created`
  // below is derived from this instead of "did this particular call just spin
  // the session up". See OpenedSession.created's doc comment.
  everPrompted: boolean
  // Recorded so the reuse path below can answer with it without rebuilding the
  // agent's selection (which costs a node lookup and a secret resolve).
  adapterId?: string
}

// ACP sessions live only in agentClient's memory, so they don't survive a dev
// server restart. Map each opencroft chat tab to its live ACP session id and
// re-create lazily — this keeps session creation idempotent per tab (no loops)
// and self-heals after a restart, without persisting fragile ids to the client.
const globalRef = globalThis as typeof globalThis & {
  __acpTabSessions?: Map<string, TabSession>
  __acpEnsureInFlight?: Map<string, Promise<OpenedSession>>
}
if (!globalRef.__acpTabSessions) {
  globalRef.__acpTabSessions = new Map()
}
if (!globalRef.__acpEnsureInFlight) {
  globalRef.__acpEnsureInFlight = new Map()
}
export const tabSessions = globalRef.__acpTabSessions
// Coalesce concurrent ensureLocalSession calls for the same tab. The inspector
// fires several on mount/focus; without this they race into duplicate, competing
// load/create sessions for a single tab.
const ensureInFlight = globalRef.__acpEnsureInFlight

async function findNodeData<T>(nodeId: string): Promise<T | null> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  for (const summary of registry.list()) {
    const space = registry.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    const spaceNodes = [...space.graphs.values()].flatMap((g) => g.graph.nodes)
    const node = (spaceNodes as { id?: string; data?: T }[]).find((n) => n.id === nodeId)
    if (node) {
      return node.data ?? null
    }
  }
  return null
}

/**
 * The context window configured on an agent node, by node id. Undefined when
 * none is set — the ordinary case, and it means "nobody established this
 * model's window", never zero.
 *
 * Exported because the offline context-usage path needs it from more than one
 * caller: a session that is not loaded has no harness to ask for a discovered
 * window, so the operator's own figure is the only authority left to it.
 */
export async function agentConfiguredWindowByNodeId(agentNodeId: string): Promise<number | undefined> {
  const agent = await findNodeData<AgentNodeData>(agentNodeId)
  return usableContextWindow(agent?.contextWindow)
}

async function resolveSecret(key: string): Promise<string> {
  if (!key) {
    return ''
  }
  return (await secrets.resolve(key)) ?? ''
}

// Same live-or-last-known resolution host.ts's listSessions uses, for one
// key instead of the whole registry. Read fresh at each return point below —
// not cached across them — since a resume can call restoreUsage in between,
// which this must see.
async function currentContextUsage(tabKey: string, agentNodeId: string): Promise<ContextUsage | null> {
  const live = agentClient.listSessions().find((m) => m.sessionKey === tabKey)
  if (live) {
    // Already normalised on its way into session state; nothing to resolve.
    return toContextUsage(live.usage)
  }
  return toContextUsage(
    undefined,
    (await readLastKnownUsage(tabKey)) ?? undefined,
    await agentConfiguredWindowByNodeId(agentNodeId),
  )
}

// Build the agent's selection in memory from its node data + Secrets Store key
// (no on-disk profile store), and open (or reuse) the ACP session for this tab.
export async function ensureLocalSessionImpl(data: { agentNodeId: string; tabKey: string }): Promise<OpenedSession> {
  const pending = ensureInFlight.get(data.tabKey)
  if (pending) {
    return pending
  }
  const run = openLocalSession(data)
  ensureInFlight.set(data.tabKey, run)
  try {
    return await run
  } finally {
    ensureInFlight.delete(data.tabKey)
  }
}

/**
 * Bring a persisted session back, by the best means available for it.
 *
 * Two ways, and which one runs decides how complete the reopened conversation
 * is:
 *
 *  - **From our own recording.** Every event this app has shown was written
 *    down as it was emitted (see session-event-store), so a transcript restored
 *    from it is exactly what the reader saw, and the agent is simply reattached
 *    underneath it. This is the path that keeps a subagent's work visible: the
 *    Claude CLI stores a subagent's transcript in a file its own replay never
 *    reads, so a delegation cannot survive the round trip through the harness —
 *    but it never has to, because we watched it happen.
 *
 *  - **From the harness's replay.** The fallback, for a session recorded before
 *    this existed, one whose recording aged out of the cap, or an agent that
 *    cannot reattach without replaying. Lossy in the way above, and still far
 *    better than opening an empty chat.
 *
 * The recording is dropped before a replay so the replayed events become its
 * fresh contents. Keeping both would leave the session's own history written
 * down twice, one copy behind the other.
 */
async function reopenPersistedSession(
  tabKey: string,
  sessionId: string,
  selection: AgentSelection,
): Promise<SessionMeta | null> {
  const recorded = await readSessionEvents(tabKey).catch((error: unknown) => {
    // A transcript that cannot be read is the state every session was in
    // before this existed, so the replay below still has its turn.
    console.error('Failed to read the persisted transcript for tab', tabKey, error)
    return []
  })
  if (recorded.length > 0) {
    const restored = await agentClient.restoreSession(sessionId, selection, recorded).catch(() => null)
    if (restored) {
      return restored
    }
  }
  await clearSessionEvents(tabKey).catch((error: unknown) => {
    console.error('Failed to clear the persisted transcript before replaying tab', tabKey, error)
  })
  return agentClient.loadSession(sessionId, selection).catch(() => null)
}

async function openLocalSession(data: { agentNodeId: string; tabKey: string }): Promise<OpenedSession> {
  const known = tabSessions.get(data.tabKey)
  if (known && agentClient.listSessions().some((s) => s.id === known.id)) {
    // `?? false` / `?? true` cover entries recorded before canSteer/everPrompted
    // existed (the map survives dev hot-reloads) — `true` is the safe default for
    // everPrompted specifically, since treating an old, possibly-already-prompted
    // session as still-new risks re-injecting session-init content into a
    // conversation that already has it, which is worse than the reverse.
    return {
      sessionId: known.id,
      canFork: known.canFork,
      canSteer: known.canSteer ?? false,
      // Entries recorded before adapterId existed fall back to the live
      // session's own, and to '' only if the agent advertises no modes at all —
      // in which case there is nothing to classify anyway.
      adapterId: known.adapterId ?? agentClient.sessionModes(known.id)?.adapterId ?? '',
      created: !(known.everPrompted ?? true),
      contextUsage: await currentContextUsage(data.tabKey, data.agentNodeId),
    }
  }
  const agent = await findNodeData<AgentNodeData>(data.agentNodeId)
  if (!agent) {
    throw new Error('Agent node not found')
  }
  // Each agent gets a persistent workspace next to the DB in the data volume,
  // keyed by slug: <cwd>/data/agent-workspace/<agent-slug>.
  const workspaceSlug = slug(agent.name ?? '') || data.agentNodeId
  const adapterId = agent.adapterId ?? 'claude'
  const containerName = agent.containerName || undefined
  const selection: AgentSelection = {
    providerId: agent.providerId ?? '',
    adapterId,
    model: agent.model ?? '',
    // The API token / base URL fall back to the OPENCLAW_GATEWAY_* env vars when
    // the node leaves them unset, so a deployment can supply them globally.
    apiKey: (await resolveSecret(agent.apiKeySecret ?? '')) || process.env.OPENCLAW_GATEWAY_TOKEN || '',
    // In a container the harness gets its own /agents/<slug> workdir (created in
    // the container on spawn); on the host it's a persistent dir in the data volume.
    cwd: containerName ? `/agents/${workspaceSlug}` : join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    containerName,
    baseUrl: agent.baseUrl || process.env.OPENCLAW_GATEWAY_URL,
    systemPrompt: agent.systemPrompt,
    reasoningEffort: agent.reasoningEffort,
    temperature: agent.temperature,
    // Only when somebody configured one. Nothing derives a window from the
    // model name any more -- a plausible-but-wrong number reads as fact on
    // every surface, and understating capacity can trigger a compaction the
    // session did not need.
    contextWindow: agent.contextWindow,
    // The tab key is already a stable session key (a group-chat thread's
    // stored sessionKey); forward it so an ACP bridge can bind this session
    // to a stable gateway session/agent instead of an ephemeral
    // acp-bridge:<uuid> session.
    sessionKey: data.tabKey,
    // Same slug used for the workspace dir — lets loadMcpServers (mcp-store.ts)
    // surface this agent's own MCP Connection node(s) without a global entry.
    mcpIdentity: workspaceSlug,
  }
  // Host spawn cwd must exist or spawn fails with ENOENT; the container path is
  // created inside the container when the harness is exec'd.
  if (!containerName) {
    await mkdir(selection.cwd, { recursive: true })
  }
  // Whether this agent takes mid-turn prompts as live-turn input — decided by
  // the adapter (single source: agent-client's table), surfaced to the client
  // so it can pick the right permission-rejection flow.
  const canSteer = supportsMidTurnInput(selection)

  // Cold start (the in-memory tab→session map is lost on a server restart): if
  // this tab's ACP session id was persisted, resume it by replaying history
  // (session/load) so the conversation comes back, and fall through to a fresh
  // session if the agent can't load it.
  //
  // The pointer is written the moment a session is created, not after its first
  // prompt. Waiting meant that for the whole of a session's first turn — which
  // for a dispatched task is the entire time the agent is working — the only
  // record it existed was this process's memory. Losing that (any restart) sent
  // the next delivery for the same key off to create a SECOND session, with no
  // way to know the first was already on the job.
  const persisted = await readPersistedSession(data.tabKey)
  if (persisted) {
    const resumed = await reopenPersistedSession(data.tabKey, persisted.id, selection)
    if (resumed) {
      const canFork = resumed.canFork ?? false
      // A resumed session counts as new only if it was never actually spoken
      // to. Since creation now persists the pointer, "resumed" no longer
      // implies "has history" — a session created and then orphaned before its
      // first prompt must still receive its opening context, or the agent
      // wakes up in a conversation with no idea what it is for.
      tabSessions.set(data.tabKey, {
        id: resumed.id,
        canFork,
        canSteer,
        everPrompted: persisted.prompted,
        adapterId,
      })
      // Re-apply any per-session config overrides (e.g. reasoning effort) the
      // user set before this tab's in-memory session was lost — loadSession
      // only reflects the agent's own resumed state, which has no way to know
      // about a change that was never written back to the agent's profile.
      const overrides = await readPersistedConfigOptions(data.tabKey)
      for (const [configId, value] of Object.entries(overrides)) {
        await agentClient.setConfigOption(resumed.id, configId, value).catch(() => {})
      }
      // Same shape of problem as the config overrides above, for context usage:
      // a resumed session reports none until its next turn ends, because ACP
      // has no request that returns it. Seed the last figure this session
      // reported so the chat opens with a populated context ring instead of a
      // blank one — the agent's next `usage_update` replaces it.
      const usage = await readPersistedUsage(resumed.id)
      if (usage) {
        agentClient.restoreUsage(resumed.id, {
          used: usage.used,
          size: usage.size,
          ...(usage.cost ? { cost: usage.cost } : {}),
          ...(usage.rateLimits ? { rateLimits: usage.rateLimits } : {}),
        })
      }
      await pinModeIfYolo(resumed.id)
      return {
        sessionId: resumed.id,
        canFork,
        canSteer,
        adapterId,
        created: !persisted.prompted,
        contextUsage: await currentContextUsage(data.tabKey, data.agentNodeId),
      }
    }
    // The pointer resolved but the session is gone — the agent can no longer
    // load it. Falling through to a fresh session is the only option, and that
    // session has none of the dead one's history, so it is `created` and gets
    // the full opening context. A dispatch must never land in a context-less
    // void because a pointer went stale.
  }

  const meta = await agentClient.createSession(selection, agent.defaultModeId)
  // canFork is the engine's own resolution: the native harness rewinds its own
  // message store, and an external ACP agent that advertised `session/fork`
  // forks its transcript through the engine (see agent-client's forkSession).
  const canFork = meta.canFork ?? false
  tabSessions.set(data.tabKey, { id: meta.id, canFork, canSteer, everPrompted: false, adapterId })
  // Durable before the caller can prompt it, so a restart mid-first-turn finds
  // this session instead of creating a rival for the same key.
  await writePersistedSession(data.tabKey, meta.id, false)
  await pinModeIfYolo(meta.id)
  return {
    sessionId: meta.id,
    canFork,
    canSteer,
    adapterId,
    created: true,
    contextUsage: await currentContextUsage(data.tabKey, data.agentNodeId),
  }
}

// A session opened while YOLO is on starts pinned to bypass, and the toggle
// listener is installed here rather than at import time so nothing subscribes in
// a process that never opens a session. Failures are logged, not thrown: the
// session itself opened fine, and an agent that will not take the mode (mid-turn,
// or not offering bypass at all) must not turn that into a failed open.
async function pinModeIfYolo(sessionId: string): Promise<void> {
  installYoloModeEnforcement()
  if (!modeLockedByYolo()) {
    return
  }
  await forceBypassMode(sessionId).catch((error: unknown) => {
    console.error('Failed to pin session to bypass mode under YOLO', sessionId, error)
  })
}

// `queue` says how this message relates to anything already held for the
// session — `wait` to be delivered on its own when the turn ends, `push` to
// interrupt and deliver the whole queue as one turn. Required, so a caller
// sending into a busy session states the intent rather than inheriting one; the
// meaning of both values lives in agentClient.prompt, never here.
//
// `front` is separate and orthogonal: it decides POSITION within the queue (e.g.
// corrective guidance after a rejected permission jumping ahead of what is
// already held), not whether to interrupt.
//
// `origin` says who the message is from, and it is the one field a caller may
// state loosely: the browser sends `{ kind: 'reader' }`, which names nobody,
// and the real name is resolved HERE from the session this request already
// carries. Server-side callers pass a concrete origin because they already know
// their own truth. See WirePromptOrigin for why the browser is not trusted with
// a name.
//
// Returns whether a turn was actually interrupted, so callers can report it
// without probing the session themselves — that answer is only correct at the
// instant the message arrives.
export async function promptLocalImpl(data: {
  sessionId: string
  text: string
  front?: boolean
  queue: QueueMode
  origin: PromptOriginInput
}): Promise<{ interrupted: boolean }> {
  // Claimed before the prompt is even sent (matching the client's own
  // deliveredOnceRef, set at deliver() call time) — a concurrent
  // ensureLocalSession call for this tab must see the claim immediately, not
  // only after the turn completes.
  let tabKey: string | undefined
  for (const [key, entry] of tabSessions) {
    if (entry.id === data.sessionId) {
      entry.everPrompted = true
      tabKey = key
      break
    }
  }
  // Record that this session has been spoken to BEFORE the prompt, not after.
  // `prompt` stays in flight for the whole turn, so persisting afterwards left
  // the durable record saying "never prompted" for exactly as long as the agent
  // was working — and a resume in that window would have re-stated a task the
  // agent was already doing.
  if (tabKey) {
    await writePersistedSession(tabKey, data.sessionId, true)
  }
  return agentClient.prompt(data.sessionId, data.text, {
    front: data.front,
    queue: data.queue,
    origin: await resolvePromptOrigin(data.origin),
  })
}

/**
 * Commit an edited turn: fork the session at that turn, then re-send it with
 * the reader's words and the transcript's own metadata.
 *
 * The split of responsibilities is the whole design. The browser sends WORDS,
 * each tagged with the position of the message it replaces, and nothing else.
 * Who wrote each message, when they wrote it, the note the delivery opened
 * with, and the context this app attached on the way out are all read back
 * here, from the delivered turn the engine already holds — never from the
 * request. That is the same boundary `WirePromptOrigin` draws for an ordinary
 * send, held for the same reason: a surface that can state authorship is a
 * surface that can forge it, and these tags are what every later reader (and
 * every replay) trusts for attribution.
 *
 * Positions rather than a full list, because the reader is only ever handed the
 * messages that HAVE words: one made entirely of application context renders
 * nothing, is not a stop in the editor, and must come back unchanged rather
 * than be re-sent as whatever the array position beside it happened to hold.
 *
 * Returns null when the turn is not there to edit — a stale tab aimed at a
 * session that has moved on gets a refusal, not somebody else's message with
 * this reader's words committed onto it.
 */
export async function editTurnLocalImpl(data: {
  tabKey: string
  sessionId: string
  eventIndex: number
  edits: { index: number; text: string }[]
}): Promise<{ sessionId: string } | null> {
  // Read before the fork. Not because the fork disturbs it (it builds a new
  // session and leaves this one's events alone), but because there is no reason
  // to branch a conversation before knowing the edit can be built at all.
  //
  // The turn is named by its position in the event log, and the ordinal that
  // rewinds to it comes back from the same read -- see `userTurnAt`. A count of
  // user turns cannot cross this boundary: the browser holds a bounded tail of
  // the conversation, so its count and this one are different numbers for the
  // same turn as soon as anything has scrolled off.
  const turn = agentClient.userTurnAt(data.sessionId, data.eventIndex)
  if (!turn) {
    // A refusal with no evidence is unrepeatable: the reader saw their words
    // on screen, and this branch says only "not there". Name what WAS at the
    // requested position and how long the log actually is, so the next
    // occurrence states the divergence instead of hiding it.
    const events = agentClient.getSessionEvents(data.sessionId)
    const at = events ? events[data.eventIndex] : undefined
    console.error(
      'edit refused: turn not found at the requested position',
      JSON.stringify({
        sessionId: data.sessionId,
        eventIndex: data.eventIndex,
        logLength: events?.length ?? null,
        foundKind: at?.kind ?? (events ? 'none' : 'unknown-session'),
      }),
    )
    return null
  }
  // The old delivery stamp goes; the re-delivery gets its own, which is what
  // that stamp means. Everything else about the framing stays.
  const original = stripDeliveryStamp(turn.text)
  const { messages } = splitDelivery(original)
  const texts = messages.map((message) => message.text)
  for (const edit of data.edits) {
    const current = texts[edit.index]
    if (current === undefined) {
      throw new Error(`Edited message ${edit.index} is not in a turn of ${texts.length}`)
    }
    // The reader's words go back behind the context they never saw. Dropping it
    // would quietly strip a message of what it was sent with; regenerating it
    // would attach today's canvas to a message sent from a different one.
    texts[edit.index] = splitEnvelope(current).context + edit.text
  }
  const text = rebuildDelivery(original, texts)
  const meta = await agentClient.forkSession(data.sessionId, turn.turnIndex)
  if (!meta) {
    return null
  }
  await adoptFork(data.tabKey, meta.id)
  // Handed over verbatim, which is what `system` means here: `text` is already
  // a finished delivery body — tags, and the interrupt note if the turn opened
  // with one. A `message` send would tag it AGAIN, wrapping one new tag naming
  // the editor around the old ones escaped into its body, which is exactly the
  // flattening this change exists to remove. The entry carries no author
  // because the authors are inside it.
  //
  // `wait` rather than `push` because nothing is being interrupted: the fork
  // starts idle with an empty queue. It does not wait either — a system entry
  // is never gated by Presence (see QueuedPrompt), so the cadence a reader set
  // for incoming messages does not hold back their own edit.
  await agentClient.prompt(meta.id, text, { queue: 'wait', origin: { kind: 'system' } })
  return { sessionId: meta.id }
}

/**
 * A page of older history, with its messages' authors resolved.
 *
 * The same resolution the live stream applies, because this page holds the
 * same messages the stream would have sent had its window reached back
 * further. A message that shows its sender's face when it arrives live and not
 * when it is paged back in is one message with two behaviours.
 *
 * The header is resolved too, for the same reason: it is the same message as
 * the block that replaces it once the rest of its turn loads.
 */
export async function sessionHistoryPageImpl(
  sessionId: string,
  beforeIndex: number,
  records: number,
): Promise<AuthoredRecordsWindow | null> {
  const window = agentClient.getRecordsWindow(sessionId, { beforeIndex, records })
  if (!window) {
    return null
  }
  const [events, header] = await Promise.all([
    Promise.all(window.events.map(withAuthors)),
    window.header ? withAuthors(window.header.event) : undefined,
  ])
  return {
    ...window,
    events,
    // `satisfies` for the same reason the other conditional spreads carry one:
    // a key spread into a literal is not checked against the literal's target
    // type, so a misspelling here would compile and a partly-loaded turn's
    // header would silently arrive without its authors.
    ...(window.header && header
      ? ({ header: { index: window.header.index, event: header } } satisfies Pick<AuthoredRecordsWindow, 'header'>)
      : {}),
  }
}

/**
 * Point a tab at a fork it just made, in memory and durably.
 *
 * Shared by the plain fork and by an edit commit because they are the same
 * event — a tab's conversation becoming a branch of itself — and the two
 * drifting apart is how a remount would resume one of them as the original.
 * A fork rewinds an already-prompted conversation, so it is never "new" for
 * envelope purposes and always carries history.
 */
export async function adoptFork(tabKey: string, sessionId: string): Promise<void> {
  tabSessions.set(tabKey, {
    id: sessionId,
    canFork: true,
    canSteer: tabSessions.get(tabKey)?.canSteer ?? false,
    everPrompted: true,
  })
  await writePersistedSession(tabKey, sessionId, true)
}

/**
 * Fork a session at a turn into a NEW conversation, addressed by a key the
 * caller has minted for it — the fork-to-new-thread flow.
 *
 * Unlike an edit commit nothing is sent and the source tab never moves: the
 * fork exists so its own conversation can be opened elsewhere, with the forked
 * turn waiting in its composer as a draft. The caller owns the key (a group
 * chat mints the thread's session key before calling) and the wording; this
 * owns the fork and everything a later reopen of the new conversation needs:
 * the durable session pointer, and the fork's trimmed transcript recorded
 * under the new key — events emitted BEFORE the key existed are not recorded
 * by the live observer, so they are seeded here, and the rebuild path works
 * for a harness that cannot replay its own sessions (the native one) exactly
 * as for one that can.
 *
 * Returns null when the turn is not there to fork — a stale client forking a
 * conversation that has moved on gets a refusal, not somebody else's history.
 */
export async function forkTurnLocalImpl(data: {
  sessionId: string
  eventIndex: number
  sessionKey: string
}): Promise<{ sessionId: string } | null> {
  const turn = agentClient.userTurnAt(data.sessionId, data.eventIndex)
  if (!turn) {
    // The same evidence an edit refusal leaves, for the same reason and in the
    // same words — these two refuse on one condition, and a fork that went
    // quiet while an edit explained itself made the pair look like two
    // different faults. Name what WAS at the requested position and how long
    // the log actually is, so the divergence is stated rather than hidden.
    const events = agentClient.getSessionEvents(data.sessionId)
    const at = events ? events[data.eventIndex] : undefined
    console.error(
      'fork refused: turn not found at the requested position',
      JSON.stringify({
        sessionId: data.sessionId,
        eventIndex: data.eventIndex,
        logLength: events?.length ?? null,
        foundKind: at?.kind ?? (events ? 'none' : 'unknown-session'),
      }),
    )
    return null
  }
  const meta = await agentClient.forkSession(data.sessionId, turn.turnIndex, { sessionKey: data.sessionKey })
  if (!meta) {
    return null
  }
  const events = agentClient.getSessionEvents(meta.id)
  if (events) {
    for (const event of events) {
      appendSessionEvent(data.sessionKey, event)
    }
  }
  await writePersistedSession(data.sessionKey, meta.id, true)
  return { sessionId: meta.id }
}

// Where `{ kind: 'reader' }` becomes a name — the trust boundary, sitting
// exactly where the signed-in session is known and nowhere else.
//
// `agentClient.prompt` only ever receives a concrete `PromptOrigin`, so
// `reader` cannot travel past this function and reach the queue, the batch tag,
// or the transcript.
async function resolvePromptOrigin(origin: PromptOriginInput): Promise<PromptOrigin> {
  if (origin.kind !== 'reader') {
    return origin
  }
  const user = await getSessionUser(getRequest())
  if (!user) {
    // Refusing is the honest answer. Attributing the message to a placeholder
    // would put words in the transcript under a name nobody owns, which is the
    // failure this resolution exists to prevent. Nothing typed is lost: the
    // hook catches the failed send, restores the draft and shows the error.
    throw new Error('Sign in to send messages')
  }
  // The account's stored handle, not the name it is displayed under: the tag
  // is durable text that outlives a rename, so what goes into it has to be the
  // thing that does not change. What a reader sees is resolved from it when the
  // message is drawn.
  return { kind: 'message', sender: await authorForPerson(user.id) }
}

/**
 * Set how often a session's agent reads its queue, and remember it.
 *
 * Persisted here rather than by an event observer because this is the only
 * thing that changes the cadence, and the engine re-emits the setting whenever
 * a session reopens — an observer would write the restored value straight back
 * on every open, for nothing.
 *
 * A session with no key is set but not remembered: the key is what a restart
 * would restore it by, and a session without one cannot be reopened as itself.
 */
export async function setPresenceLocalImpl(data: { sessionId: string; presence: Presence }): Promise<void> {
  agentClient.setPresence(data.sessionId, data.presence)
  const sessionKey = agentClient.listSessions().find((session) => session.id === data.sessionId)?.sessionKey
  if (!sessionKey) {
    return
  }
  await writePersistedPresence(sessionKey, data.presence)
}

// Resolve the live ACP session for a session key:
//   1. Prefer the remembered in-memory session (exact key), if still live, so
//      repeated deliveries reuse the same session instead of spawning
//      duplicates.
//   2. Otherwise the durable pointer for this key, if the session it names is
//      still live — memory is per-process and empties on every restart, so it
//      cannot be the only place a session is looked for.
//   3. Return null when nothing live exists — the caller then resumes the
//      durable pointer, or creates a fresh session if it can no longer load.
//
// Async because step 2 reads the settings-backed store; every caller awaits it.
export async function findTargetSessionImpl(data: { baseKey: string }): Promise<{ sessionId: string } | null> {
  const createdById = new Map(agentClient.listSessions().map((s) => [s.id, s.createdAt]))
  // 1. The remembered session, if still live.
  const exact = tabSessions.get(data.baseKey)
  if (exact && createdById.has(exact.id)) {
    return { sessionId: exact.id }
  }
  // 2. The durable pointer, but only if that session is still live. A pointer
  // to a session the agent can no longer serve is not a target: returning it
  // would prompt into nothing. Reporting no target instead sends the caller
  // through the resume path, which either loads it or replaces it honestly.
  const persisted = await readPersistedSession(data.baseKey)
  if (persisted && createdById.has(persisted.id)) {
    return { sessionId: persisted.id }
  }
  return null
}

// The reader's Stop. Delegates the decision to agentClient.stop, which reads
// the queue next to the queue rather than trusting a caller's render-old copy:
// with unread messages held it cancels AND delivers them, otherwise it is an
// ordinary cancel. Returns how many were delivered so a caller can say so.
export async function stopLocalImpl(sessionId: string): Promise<{ delivered: number }> {
  return agentClient.stop(sessionId)
}

// Deliver everything waiting, now: the Unread section's divider, pressed. An
// empty text under `push` is the engine's own "hand over what is held" case —
// no new message rides along, and the framing is whatever the engine already
// does for a hand-over. Nothing waiting is a no-op, so a double press costs
// nothing. The queue snapshots it produces are what tell the UI what became
// of the queue; there is no answer here worth returning.
export async function deliverQueueLocalImpl(sessionId: string): Promise<void> {
  await agentClient.prompt(sessionId, '', { queue: 'push', origin: { kind: 'system' } })
}

export async function cancelLocalImpl(sessionId: string): Promise<void> {
  await agentClient.cancel(sessionId)
}

export function hasActiveTurnImpl(sessionId: string): boolean {
  return agentClient.hasActiveTurn(sessionId)
}

// Stop a tab's agent process WITHOUT forgetting the tab: ends the live ACP
// session (gracefully, or kills the subprocess if nothing else shares it) and
// drops the in-memory pointer, but deliberately keeps the durable
// tabKey->sessionId pointer and the config overrides. The next open falls
// through to openLocalSession's cold-start resume and reattaches to the SAME
// session, so the conversation is still there.
//
// The distinction from forgetLocalSessionImpl below is the whole point, and
// picking the wrong one is silent: both leave no live process, and the loss
// only shows up later as a chat that reopens empty. Use this one wherever the
// history has to survive -- stopping a process, or removing an agent from a
// group chat, whose threads are kept precisely so they stay readable.
export async function stopLocalSessionProcessImpl(tabKey: string): Promise<void> {
  const entry = tabSessions.get(tabKey)
  if (entry) {
    await agentClient.deleteSession(entry.id)
    tabSessions.delete(tabKey)
  }
}

// Drop a tab's session entirely: the live ACP session (and the agent process it
// owns), the in-memory tab->session pointer, and the durable pointer + config
// overrides a restart would otherwise resume from. Shared by the sidebar's chat
// delete (acp.ts) and a group-chat thread delete -- a thread is an ordinary
// session, so it goes away the same way.
//
// This one is for when the tab itself is going away. If the tab survives, you
// want stopLocalSessionProcessImpl above.
export async function forgetLocalSessionImpl(tabKey: string): Promise<void> {
  const entry = tabSessions.get(tabKey)
  if (entry) {
    await agentClient.deleteSession(entry.id)
    tabSessions.delete(tabKey)
  }
  // Drop the durable pointer too, so a later restart doesn't resurrect it.
  await deletePersistedSession(tabKey)
  await deletePersistedConfigOptions(tabKey)
  await deletePersistedPresence(tabKey)
  // This is where the key is retired for good, which is why the durable queue
  // is cleared HERE and not when the engine drops a live session — that also
  // happens when a process is stopped and the conversation is meant to survive,
  // and anything still held for it must survive with it. Rows left behind by a
  // tab that is gone are orphans nothing would ever load or delete.
  await queueStore.clear(tabKey)
  // The recorded transcript goes with it, for the same reason and with the same
  // distinction: stopping a process keeps it, retiring the tab does not.
  await clearSessionEvents(tabKey)
}
