import type { SessionConfigOption } from '@agentclientprotocol/sdk'

export interface SpawnConfig {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface AgentSelection {
  providerId: string
  adapterId: string
  model: string
  apiKey: string
  cwd: string
  // Optional base-URL override (e.g. a custom OpenAI-compatible endpoint).
  // When set, it wins over the provider's table endpoint in buildSpawnConfig.
  baseUrl?: string
  // System prompt for the in-process Custom (native) harness. Ignored by ACP
  // agents, which carry their own. Lets each profile define its own prompt.
  systemPrompt?: string
  // Reasoning effort (e.g. "low" | "medium" | "high" | "minimal"); empty = off.
  // Custom harness passes it as reasoning_effort; ACP agents get it applied via
  // their thought_level config option when they expose one.
  reasoningEffort?: string
  // Sampling temperature for the Custom (native) harness; undefined = provider
  // default. Ignored by ACP agents, which manage their own sampling.
  temperature?: number
  // The model's context window in tokens, when it is CONFIGURED. There is no
  // default and nothing derives one: a window is either known or it is not.
  //
  // This replaced a table that guessed from the model name, which could not be
  // made correct -- one substring cannot separate a 200k model from a 1M one in
  // the same family, and every entry rotted on the next provider release. A
  // wrong-but-plausible window is worse than none: it understates capacity and
  // can trigger a compaction the session did not need.
  //
  // Only the in-process harness reads this. An ACP agent reports its own window
  // over the protocol and is believed; nothing here overrides it.
  contextWindow?: number
  // External session key forwarded via ACP `_meta.sessionKey`. Bridges that
  // route by their own session key (e.g. OpenClaw's ACP bridge → Gateway) use
  // it to bind this session to a specific server-side session/agent; ACP agents
  // that don't recognize it ignore unknown `_meta` keys.
  sessionKey?: string
  // When set, the harness subprocess runs inside this Docker container via
  // `docker exec` instead of on the host. `cwd` and the auth/config env vars are
  // forwarded into the container; unset means spawn on the host as before.
  containerName?: string
  // Opaque per-caller identity, forwarded verbatim to AgentClientOptions'
  // loadMcpServers so a host can scope its own MCP-server resolution to this
  // caller (e.g. surface a caller's own configured servers in addition to a
  // shared list) — the engine never reads or interprets this value itself.
  mcpIdentity?: string
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  // Last time any event was emitted on this session (turn activity, config
  // changes, etc.) — mirrors createdAt until the first emit. Lets a host show
  // session recency without scanning the event log.
  lastActivityAt: number
  profileId?: string
  // Whether this session's agent can fork its history (native harness only).
  canFork?: boolean
  // The external session key this session was created with (selection.sessionKey),
  // mirrored here so a host can look up a session by key without also tracking
  // its own id — see agent-client.ts's emit/createSession.
  sessionKey?: string
  // Context the session is holding, as last reported by its harness via ACP
  // `usage_update`: `used` tokens, and `size` (the model's context window) when
  // the harness knows it. Composed at read time from live session state, so it
  // is a snapshot, not a stored field.
  //
  // Absent means UNKNOWN, never "nothing held": a harness that reports no usage,
  // or a session that has not completed a turn since it was loaded, both look
  // like this. A caller deciding whether to compact must not read it as zero.
  usage?: { used: number; size?: number }
  // Server-held prompts waiting for the current turn to end, composed at read
  // time from the live queue (same snapshot the 'queue' event publishes). A
  // number, not undefined: an idle session's queue is genuinely empty, so 0 is
  // a fact here — unlike `usage`, there is no unknown state to keep distinct.
  queuedMessages?: number
}

export interface PlanItem {
  content: string
  status: string
  priority: string
}

export interface PermissionOpt {
  id: string
  label: string
  kind: string
}

// A prompt held while a turn is running. ACP allows one prompt-turn at a time
// per session, so mid-turn messages are queued in the session state and
// delivered in order as turns end. Surfaced to clients via the 'queue' event.
export interface QueuedPrompt {
  id: string
  text: string
}

export type ChatEvent =
  | { kind: 'user'; text: string }
  | { kind: 'agent_message'; text: string }
  | { kind: 'agent_thought'; text: string }
  | {
      kind: 'tool_call'
      toolCallId: string
      title: string
      status: string
      toolKind?: string
      input?: unknown
    }
  | {
      kind: 'tool_update'
      toolCallId: string
      title?: string
      status?: string
      input?: unknown
      output?: unknown
    }
  | { kind: 'plan'; entries: PlanItem[] }
  | {
      kind: 'permission_request'
      requestId: string
      title: string
      options: PermissionOpt[]
    }
  | { kind: 'permission_resolved'; requestId: string; optionId?: string }
  | { kind: 'ask_user'; requestId: string; message: string }
  | { kind: 'ask_user_resolved'; requestId: string }
  | { kind: 'modes'; available: SessionMode[]; current: string }
  | { kind: 'mode_changed'; current: string }
  // Full snapshot of the session's dynamic config options (mode/model/thought
  // level/etc., ACP agents only), replacing any prior snapshot wholesale —
  // same "last update wins" semantics as `modes`/`queue`.
  | { kind: 'config_options'; options: SessionConfigOption[] }
  // Agent-pushed session metadata (currently just title); undefined title
  // means the agent didn't set one on this update.
  | { kind: 'session_info'; title?: string }
  // Full snapshot of the session's undelivered prompt queue, emitted on every
  // queue change. Snapshot (not delta) so the stored-event replay leaves any
  // (re)connecting client with the current queue: fold the LAST one seen.
  | { kind: 'queue'; items: QueuedPrompt[] }
  | { kind: 'usage'; used: number; size?: number }
  | { kind: 'turn_end'; stopReason: string }
  | { kind: 'error'; message: string }

export interface SessionMode {
  id: string
  name: string
  description?: string
}
