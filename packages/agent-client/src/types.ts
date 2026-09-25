import type {
  AvailableCommand,
  ElicitationContentValue,
  ElicitationSchema,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'

import type { DeliveredAttachment } from './attachments'

// Re-exported so consumers (agent-chat, hosts) can type the advertised command
// list and elicitation forms without depending on the protocol SDK directly.
export type { AvailableCommand, ElicitationContentValue, ElicitationSchema }

export interface SpawnConfig {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  // Directories that must exist before the harness starts (e.g. a harness home
  // it refuses to create itself). Created on the host for a host spawn, and
  // inside the container by the docker-exec wrapper for a container spawn.
  ensureDirs?: string[]
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
  // The profile's word that its OpenAI-compatible endpoint also serves OpenAI's
  // Responses API. Harnesses that speak only that API (Codex) are offered for a
  // provider without a Responses endpoint of its own only when this is set —
  // most compatible servers implement Chat Completions alone.
  responsesApi?: boolean
  // A directory the host owns for harness state. An adapter that declares
  // `homeEnv` gets `<harnessHome>/<adapter id>` as its home, so the harness
  // never reads the host user's own config for it. Must be valid where the
  // harness runs (inside the container for a container spawn). Unset: the
  // engine derives one inside `cwd`.
  harnessHome?: string
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
  // The harness adapter id this session runs on (e.g. 'claude-subscription'),
  // mirrored from the selection so a host can scope per-harness behavior —
  // rate-limit displays, usage accounting — without re-deriving the spawn.
  adapterId?: string
  // The model id the session was created with, mirrored from the selection.
  // A live model switch through a config option is not reflected here.
  model?: string
  // The external session key this session was created with (selection.sessionKey),
  // mirrored here so a host can look up a session by key without also tracking
  // its own id — see agent-client.ts's emit/createSession.
  sessionKey?: string
  // Context the session is holding, as last reported by its harness via ACP
  // `usage_update`: `used` tokens, and `size` (the model's context window) when
  // the harness knows it. `cost` and `rateLimits` ride the same update when
  // the harness reports them (see SessionUsage). Composed at read time from
  // live session state, so it is a snapshot, not a stored field.
  //
  // Absent means UNKNOWN, never "nothing held": a harness that reports no usage,
  // or a session that has not completed a turn since it was loaded, both look
  // like this. A caller deciding whether to compact must not read it as zero.
  usage?: SessionUsage
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

// One entry of the agent's execution plan (ACP `plan` session update — the
// stable one, not the draft planId-addressed `plan_update`). ACP entry status
// spellings are 'pending' | 'in_progress' | 'completed'; the field stays a
// string so an agent's own vocabulary still folds and renders.
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
 *
 * `attachments` rides on every kind, beside the text rather than in it, and is
 * held and made durable with the entry -- a picture must not travel when a
 * message goes straight through and vanish when the same message waits. See
 * attachments.ts.
 */
export type QueuedPrompt = (
  | { id: string; kind: 'message'; sender: string; sentAt: string; text: string }
  | { id: string; kind: 'system'; text: string }
  | { id: string; kind: 'command'; sender: string; sentAt: string; text: string }
) & { attachments?: DeliveredAttachment[] }

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
 * `online` also has no window: nothing waits longer than the turn already
 * running. It exists because steering made `realtime` mean read MID-turn on a
 * harness that can — online is the reader keeping the turn boundary: messages
 * land the moment the agent is idle, and a busy agent reads them the moment
 * its own turn ends, never during it. "Online" as in reachable and reading
 * promptly, just not mid-sentence.
 *
 * A union rather than a name plus an optional interval: only `custom` has one,
 * and an optional field would let the other four carry a number that silently
 * means nothing.
 */
export type Presence =
  | { kind: 'high-attention' }
  | { kind: 'realtime' }
  | { kind: 'online' }
  | { kind: 'minutes' }
  | { kind: 'hourly' }
  | { kind: 'daily' }
  | { kind: 'custom'; intervalMs: number }

/**
 * One context compaction of a session, as reported by the agent over ACP
 * (`compaction_update` / `compaction_summary_chunk`, gated on the client
 * advertising `clientCapabilities.session.compaction`). The engine merges the
 * protocol's ID-addressed patches into this record, so every `compaction`
 * event carries the entity's full current state — fold the LAST one seen per
 * `compactionId`.
 *
 * `status` is open-ended by protocol; 'in_progress' | 'completed' | 'failed' |
 * 'cancelled' are the defined values. `summary` is the user-displayable text
 * the compaction retained; the trigger and token counts come from the
 * bridge's `_meta.contextCompaction` extension and are absent when the agent
 * did not report them.
 */
export interface CompactionState {
  compactionId: string
  status: string
  summary?: string
  error?: string
  trigger?: 'manual' | 'automatic'
  preTokens?: number
  postTokens?: number
  durationMs?: number
}

/**
 * A subagent session the harness spawned under a parent session (ACP draft
 * `subagent_spawned` / `subagent_state_update`, gated on the client declaring
 * the `subagents` capability). `state` is absent while the subagent is live;
 * a terminal state closes it.
 */
export interface SubagentInfo {
  subagentSessionId: string
  name: string
  task: string
  state?: 'completed' | 'failed' | 'cancelled' | 'disconnected' | string
}

/**
 * A background task: a background bash job, a loop, a build — anything that
 * runs detached from the prompt turn. Usually one the harness reported (ACP
 * AIR draft `async_task_spawned` / `async_task_progress` /
 * `async_task_state_update`); the application can report its own through the
 * engine's `upsertAsyncTask` (see `origin`). `canStop` marks tasks the client
 * may stop via the engine's stopAsyncTask; `showInTranscript` is the
 * reporter's own advice on whether to draw it in the conversation (a task
 * that is pure plumbing arrives with it false).
 */
export interface AsyncTaskInfo {
  asyncTaskId: string
  name: string
  taskType: string
  description: string
  state: 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | string
  canStop: boolean
  showInTranscript: boolean
  summary?: string
  lastToolName?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  outputFilePath?: string
  toolCallId?: string
  // Who runs the task, which is also who can stop it. Absent: the harness
  // reported it, and a stop goes to the harness. `'host'`: the application
  // runs it on the session's behalf, and a stop goes back to the application
  // (AgentClientOptions.stopHostTask) — the harness has never heard of it.
  //
  // On the record itself rather than kept beside it, because the record is
  // what travels: through the event log, a restore and every fold. A stop
  // issued for a task that came back that way still has to find its owner.
  origin?: 'host'
  // The subagent session that reported the task, when it was not the session
  // itself: a background command a subagent started. Absent for the
  // session's own tasks. The record still lives in the session's task list,
  // and a stop still names the session, not the subagent — see stopAsyncTask.
  subagentSessionId?: string
}

export type ChatEvent =
  // `messageId` on the chunk-born conversation events is the harness's own
  // message boundary (stamped per model message): two chunks with DIFFERENT
  // defined ids belong to different messages and must not merge into one
  // block — the signal that keeps steered turns readable. Absent means the
  // harness said nothing, which folds exactly as before.
  //
  // `attachments` on a user event is what the delivery carried beside its
  // text, each marked with the message it came with. Only a delivery made here
  // has it: a harness replay says nothing about them.
  | { kind: 'user'; text: string; messageId?: string; attachments?: DeliveredAttachment[] }
  | { kind: 'agent_message'; text: string; messageId?: string }
  | { kind: 'agent_thought'; text: string; messageId?: string }
  | {
      kind: 'tool_call'
      toolCallId: string
      title: string
      status: string
      toolKind?: string
      input?: unknown
      // The tool's PROGRAMMATIC name (`Write`, `Bash`, `mcp__local__call`) as
      // the agent reports it, where `title` is the human sentence it wants
      // drawn ("Write src/checkout/form.tsx"). Both, because they answer
      // different questions: the title is what a reader sees, and this is what
      // a client matches on to decide HOW to draw it. A client keying a view
      // registry on the title matches nothing whose title embeds an argument,
      // which is every file tool.
      //
      // Absent when the agent did not send one — an older bridge, or an update
      // that only refines a call already announced.
      name?: string
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
  // An elicitation from the agent. Plain `message` alone is a free-text ask;
  // `form` (ACP form mode) carries the JSON schema the answer must match —
  // resolve it with a content object keyed by the schema's properties; `url`
  // (ACP url mode) asks the reader to visit a link, and usually resolves from
  // the agent's own completion notification rather than a typed answer.
  | { kind: 'ask_user'; requestId: string; message: string; form?: ElicitationSchema; url?: string }
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
  // A context compaction's full current state (see CompactionState) — emitted
  // on every status transition, in timeline position. An entity is upserted by
  // `compactionId`: the first event places it, later ones replace its fields.
  | { kind: 'compaction'; compaction: CompactionState }
  // A subagent's full current state — upserted by `subagentSessionId`, same
  // shape of contract as `compaction`: the first event fixes its place in the
  // parent transcript, later ones replace its fields.
  | { kind: 'subagent'; subagent: SubagentInfo }
  // One step of a subagent's own transcript, nested verbatim: the child
  // session's update translated to the same event vocabulary and wrapped with
  // the child's id. Folds build the subagent's live transcript from these.
  //
  // Nesting follows the spawn tree: a subagent spawned BY a subagent is
  // announced as a `subagent` event inside its parent's `subagent_event`, and
  // its own steps arrive wrapped once per level, outermost first.
  | { kind: 'subagent_event'; subagentSessionId: string; event: ChatEvent }
  // A background task's full current state — upserted by `asyncTaskId`, same
  // contract as `subagent`.
  | { kind: 'async_task'; task: AsyncTaskInfo }
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
  | { kind: 'usage'; used: number; size?: number; cost?: SessionCost; rateLimits?: RateLimitWindow[] }
  | {
      kind: 'turn_end'
      stopReason: string
      /** The turn's own token spend, when the harness reported one on the prompt response. */
      usage?: TurnTokenUsage
      /** The same spend with the harness's per-model breakdown, when its `_meta` carried one. */
      quota?: TurnQuota
      /** A typed session failure the harness attached to the turn (e.g. a quota exhaustion). */
      failure?: SessionFailure
      // The session's harness and its RESOLVED model, carried on the event so a
      // consumer records what actually ran without a separate lookup against the
      // live session (which a session created without a model mirror — a
      // group-chat thread — answers as unknown). `adapterId` is the selection's;
      // `model` is resolved at the boundary from what the turn really used, in
      // order: the largest model in the harness's per-model quota breakdown (a
      // real id, subagents included), then the model config option's current
      // value (a live switch the selection mirror never saw), then the
      // selection's own model. Absent only when none of the three is known.
      adapterId?: string
      model?: string
      // The turn's OWN cost, in the session's currency — the increment this turn
      // added, not the running total. Harnesses report cost cumulatively per
      // session, so the engine differences consecutive readings and hands over
      // the delta, which is the figure day/model accounting sums. A compaction
      // or conversation reset drops the cumulative back down; the boundary reads
      // that as the post-reset spend rather than a negative turn. Absent when the
      // harness does not price the session.
      cost?: SessionCost
    }
  | { kind: 'error'; message: string }

/**
 * A context-usage reading as the engine holds and reports it: the harness's
 * `used`/`size` pair, plus what rode alongside the same `usage_update` — the
 * session's cumulative cost and the account's rate-limit windows, when the
 * harness reports them. `cost`/`rateLimits` persist across readings (they are
 * account- and session-scale state, not per-turn measurements), so they are
 * absent only until the first report, not re-asking every update.
 */
export interface SessionUsage {
  used: number
  size?: number
  cost?: SessionCost
  rateLimits?: RateLimitWindow[]
}

/**
 * Cumulative session cost, as ACP `usage_update.cost` reports it.
 */
export interface SessionCost {
  amount: number
  currency: string
}

/**
 * One subscription rate-limit window, as the harness reported it. Claude's
 * bridge forwards these on the `_claude/rateLimit` `_meta` key of a
 * `usage_update`; other harnesses may carry their own. `window` is the
 * harness's own window name (`five_hour`, `seven_day`, …) — open-ended, since
 * the set of windows is the provider's business, not ours.
 *
 * `utilization` is percent of the window USED (0-100), so remaining is its
 * complement — converted from the fraction the claude bridge sends (see
 * normalizeUtilization in usage-meta). `resetsAt` is epoch ms, normalized
 * from whatever unit the harness sent (see normalizeResetsAt there too).
 */
export interface RateLimitWindow {
  /** `allowed` | `allowed_warning` | `rejected` — the harness's own verdict. */
  status: string
  /** The harness's window name (`five_hour`, `seven_day`, `overage`, …). */
  window: string
  utilization?: number
  resetsAt?: number
}

/**
 * A prompt turn's token spend, mirroring ACP's experimental PromptResponse
 * `usage`. Counters the harness did not report stay absent, never zero.
 */
export interface TurnTokenUsage {
  totalTokens: number
  inputTokens?: number
  outputTokens?: number
  thoughtTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * The per-model breakdown some harnesses attach beside a turn's usage (the
 * claude bridge's `_meta.quota`, shaped like codex-acp's). `modelUsage` can
 * total MORE than `tokenCount`: it counts subagents and internal calls the
 * main-loop figure excludes.
 */
export interface TurnQuota {
  tokenCount: TurnTokenUsage
  modelUsage?: { model: string; tokenCount: TurnTokenUsage }[]
}

/**
 * A typed session failure (the bridge's AIR `sessionFailure` extension): the
 * harness's own word on WHY a turn ended with no answer — a quota exhaustion,
 * an auth requirement, a transport loss — instead of a generic error string.
 * `category` groups it (`limit`, `access`, `service`, …); open-ended.
 *
 * Neither bridge puts its own failure kind on the wire: claude-agent-acp
 * 0.79.0 and codex-acp 1.13.1 both keep `quota_exhausted`, `auth_required`, …
 * internal and send only the category and actions that kind maps to. So
 * `label` is what a host keys on, and parseSessionFailure derives it (see
 * there); `kind` is present only when a harness does send one.
 */
export interface SessionFailure {
  id: string
  /** The failure's name in the bridges' shared vocabulary, or its category when the wire cannot tell kinds apart. */
  label: string
  /** The harness's own kind, verbatim — absent from both current bridges. */
  kind?: string
  /** The claude bridge's refinement of its kind (`claude_subscription_not_supported` on a sign-in failure). */
  reason?: string
  /** Increases per `id`: a later revision of the same failure supersedes the earlier one. */
  revision?: number
  category: string
  severity: string
  title: string
  details?: string
  actions?: string[]
}

export interface SessionMode {
  id: string
  name: string
  description?: string
  // The agent's own extension data for the mode, passed through untouched.
  // Some agents state what a mode does here, which session-modes.ts reads.
  _meta?: Record<string, unknown>
}
