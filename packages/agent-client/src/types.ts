import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk'

// Re-exported so consumers (agent-chat, hosts) can type the advertised command
// list without depending on the protocol SDK directly.
export type { AvailableCommand }

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
  // THE PRIMARY AUTHORITY on whether a ratio may be shown, not a fallback
  // consulted in one exceptional case. A window reported over ACP is a claim
  // rather than evidence -- nothing in the protocol distinguishes a bridge's
  // seeded family default from the corrected value that later replaces it --
  // so this field, or an in-process discovery, is what a ratio rests on, and
  // its absence means tokens without one.
  //
  // Deliberately not restated here beyond that: the rule and its exceptions
  // live in context-window.ts, which is the only place they are applied.
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
  // How often this session's agent reads its queue. Always present: every
  // session has a reading cadence, and `realtime` is a real answer rather than
  // an absent one.
  presence?: Presence
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
/**
 * One entry waiting in a session's queue.
 *
 * The kind is a union rather than a flag for the same reason the delivery is:
 * a system entry that forgets to declare itself gets batched and tagged, and a
 * tag in front of `/compact` stops it being a command at all. Forgetting to pick
 * a variant does not compile; forgetting a flag falls through to the dangerous
 * side.
 *
 * - `message` — something somebody sent. Carries who and when, because those
 *   have to reach the agent and survive a reload, and because Presence gates on
 *   how long the oldest one has waited.
 * - `system` — a prompt the application issues on its own behalf. It has no
 *   author, is never batched with anything, and is never gated by Presence.
 * - `command` — a harness command somebody sent (leading `/`). Keeps its author
 *   and time for the queue UI, but is DELIVERED verbatim like a system entry:
 *   the harness recognises a command by its first characters, so a tag or note
 *   in front of it stops it being a command at all. Never batched — a batch
 *   would put other text around it.
 */
export type QueuedPrompt =
  | { id: string; kind: 'message'; sender: string; sentAt: string; text: string }
  | { id: string; kind: 'system'; text: string }
  | { id: string; kind: 'command'; sender: string; sentAt: string; text: string }

/**
 * Who a prompt is from, which decides whether it is a message at all.
 *
 * A union rather than an optional sender, because the two sides fail
 * differently: a message with no sender loses its author permanently once the
 * transcript is replayed, and a system prompt treated as a message gets a tag
 * in front of it — which stops `/compact` being a command. Neither is
 * reachable by forgetting to say which.
 */
export type PromptOrigin = { kind: 'message'; sender: string } | { kind: 'system' }

/**
 * How a message relates to the queue it is being sent into. Required at every
 * send surface rather than defaulted: sending into a busy session is a real
 * choice, and a default would make it silently for the caller.
 *
 * - `wait` — the message is held, and delivered with everything else waiting
 *   with it when the queue is next handed over. It is the MESSAGE that waits,
 *   never the caller: a send resolves as soon as the message is safely held,
 *   because blocking until an agent finished would hang a caller for tens of
 *   minutes. WHEN the hand-over happens is Presence's answer, not this one.
 * - `push` — interrupt whatever is running and deliver everything held, this
 *   message included and last, as ONE turn. One interrupt for the whole queue
 *   rather than one per held message, and Presence is bypassed: a caller asking
 *   for attention now is not waiting for a reading window.
 *
 * Against an EMPTY queue under realtime Presence the two are the same ordinary
 * send. Under any other Presence they are not: `wait` still waits.
 *
 * Defined here, and the behaviour implemented once in `agentClient.prompt`, so
 * surfaces differ only in how they are addressed — never in what these mean.
 */
export type QueueMode = 'wait' | 'push'

/**
 * How often the agent reads its queue.
 *
 * `queue` says how a message relates to what is already held; this says when
 * what is held is handed over. They are independent axes: `wait` under
 * `realtime` goes at the next turn boundary, `wait` under `hourly` waits for
 * the hour, and `push` ignores this entirely.
 *
 * The window is measured from the OLDEST waiting message, not the newest — the
 * question it answers is "how long has anyone been waiting for a reply", and
 * measuring from the newest would let a steady trickle of messages hold the
 * queue shut forever.
 *
 * `high-attention` never opens a window at all — but unlike `realtime`, which
 * also has no window, it reaches the next delivery as an interrupt: every
 * message goes now, with a stop for whatever turn is running, and the delivery
 * opens with the compact per-interrupt note rather than the queue-jump one.
 * It is a Presence rather than a `queue` mode because the sender does not opt
 * in — the reader set the cadence, and everything sent to them lands under it.
 *
 * A union rather than a name plus an optional interval: only `custom` has one,
 * and an optional field would let the other four carry a number that silently
 * means nothing.
 */
export type Presence =
  | { kind: 'high-attention' }
  | { kind: 'realtime' }
  | { kind: 'minutes' }
  | { kind: 'hourly' }
  | { kind: 'daily' }
  | { kind: 'custom'; intervalMs: number }

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
  // Full snapshot of the commands the agent advertised (ACP
  // `available_commands_update`), replacing any prior snapshot wholesale.
  // Composers use it for slash-command autocomplete; a command is still SENT
  // as an ordinary prompt whose text starts with `/`.
  | { kind: 'available_commands'; commands: AvailableCommand[] }
  // Agent-pushed session metadata (currently just title); undefined title
  // means the agent didn't set one on this update.
  | { kind: 'session_info'; title?: string }
  // Full snapshot of the session's undelivered prompt queue, emitted on every
  // queue change. Snapshot (not delta) so the stored-event replay leaves any
  // (re)connecting client with the current queue: fold the LAST one seen.
  | { kind: 'queue'; items: QueuedPrompt[] }
  // The session's reading cadence, emitted whenever it changes. A snapshot for
  // the same reason `queue` is: a reconnecting client folds the last one seen
  // and knows what it is looking at, rather than having to ask.
  | { kind: 'presence'; presence: Presence }
  | { kind: 'usage'; used: number; size?: number }
  | { kind: 'turn_end'; stopReason: string }
  | { kind: 'error'; message: string }

export interface SessionMode {
  id: string
  name: string
  description?: string
}
