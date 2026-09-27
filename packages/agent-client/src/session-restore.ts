// Turning a transcript somebody else kept back into a session's state.
//
// `loadSession` rebuilds a session by asking the harness to replay its own
// history; this rebuilds one from an event log the HOST recorded as those
// events were emitted. The two differ in what they can be trusted with: a
// replay is the harness's present-tense account of a conversation, while a log
// is a recording of a process that has since stopped. So a restored log is not
// simply fed back through the emit path — two classes of event have to be
// treated as the artefacts they now are, and the session's "last value wins"
// state has to be folded back out of the log rather than waited for.
//
// Pure, and deliberately: everything here is a function of the events alone,
// which is what lets the rules below be tested without a session, a connection
// or a harness.

import type { SessionConfigOption } from '@agentclientprotocol/sdk'

import type {
  AsyncTaskInfo,
  AvailableCommand,
  ChatEvent,
  CompactionState,
  PlanItem,
  SessionCost,
  SessionMode,
  SubagentInfo,
} from './types'

/**
 * The session state a log implies, folded out of it.
 *
 * Every field here is "last value wins" state that the engine mirrors on the
 * session as it arrives (see agent-client's handleUpdate) so that a subscriber
 * joining mid-transcript can be handed the current value without scanning
 * history. A restored session has the whole history and none of the mirror, so
 * without this fold a chat that opens past the point where its modes were
 * announced has no modes at all — the events are in the log, just not in the
 * window anyone reads.
 *
 * `queue` and `presence` are absent on purpose. Both are live state owned by
 * the host's durable stores, which are read separately when the session opens;
 * a value recovered from the log would be a snapshot of what was true when the
 * process stopped, and for the queue that means messages that have since been
 * delivered coming back as unread.
 */
export interface RestoredSessionState {
  modes: { available: SessionMode[]; current: string } | null
  configOptions: SessionConfigOption[]
  commands: AvailableCommand[]
  title?: string
  // `cost` is the session's running total as last recorded: the restored
  // session's cost baseline, besides what its reading displays.
  usage?: { used: number; size?: number; cost?: SessionCost }
  compactions: Map<string, CompactionState>
  // The whole spawn tree, as the live session holds it: the session's own
  // subagents and the ones they spawned.
  subagents: Map<string, SubagentInfo>
  // The spawning subagent of each subagent in `subagents` that another
  // subagent spawned; the session's own are absent. Routing a still-running
  // subagent's notifications needs the chain, not only the record.
  subagentParents: Map<string, string>
  asyncTasks: Map<string, AsyncTaskInfo>
  // The agent's plan, folded the same "last value wins" way handleUpdate
  // mirrors it live: the last plan event in the log is the current plan, and an
  // empty one means the agent had cleared it before stopping. Without this, a
  // restored session has the plan's events in its transcript but no mirror, and
  // a windowed subscribe would hide the checklist behind the history cut.
  plan?: PlanItem[]
}

/**
 * The events that may be seeded into a restored session, and the closures a
 * restart owes the ones that were still open.
 *
 * Two edits, and each is about a promise that died with the process that made
 * it:
 *
 *  - **`queue` snapshots are emptied.** A queue snapshot describes what was
 *    waiting at the moment it was published, and what is waiting NOW comes from
 *    the durable queue when the session opens. Seeding one means a chat can
 *    open showing messages as unread that were handed over long ago — and
 *    unlike a stale tool status, a reader cannot tell it is looking at history.
 *    Emptied where it sits rather than removed, for the reason below.
 *
 *  - **An unanswered permission request or elicitation is closed.** Its
 *    `resolve` lived in the memory of a process that is gone, so the buttons a
 *    reader would be shown resolve nothing at all: pressing one reaches an
 *    engine that has never heard of the request id and silently does nothing.
 *    The request stays in the transcript — it was asked, and that is true — but
 *    it is marked answered-by-nobody rather than drawn as still waiting.
 *
 * Everything else is carried verbatim. A tool call left `in_progress` by a
 * restart stays `in_progress`: that is what happened, the reader can see the
 * turn ended after it, and inventing a terminal status would be this layer
 * claiming to know how the work finished.
 *
 * ## POSITIONS ARE PART OF THE CONTRACT
 *
 * The result is position-for-position the log it was given: event N in, event
 * N out, for every N. Only the tail grows, with the closures above.
 *
 * That is not tidiness. A user turn is NAMED by its index in this array —
 * that is what an edit commit and a fork send to say which message they mean
 * (see `userTurnAt`) — and a browser holding indices from before a restart has
 * no way to learn that they shifted. Drop one event here and every index after
 * it is off by one: an edit rewrites the wrong message, a fork branches at the
 * wrong turn, and when the index falls off the end the reader is told the
 * conversation is not available. All three are silent, and the last one is the
 * kindest of them.
 *
 * So an event that must not be RESTORED is emptied rather than removed, and a
 * closure that must be ADDED goes at the end where it shifts nothing.
 */
export function restorableEvents(events: readonly ChatEvent[]): ChatEvent[] {
  const restored: ChatEvent[] = []
  const openPermissions = new Set<string>()
  const openAsks = new Set<string>()
  for (const event of events) {
    switch (event.kind) {
      case 'queue':
        // EMPTIED IN PLACE, never dropped. What it says has to go (above);
        // where it sits has to stay (see this function's doc on positions).
        // An empty snapshot says both: nothing is waiting, and the events
        // after this one are still where they were.
        restored.push({ kind: 'queue', items: [] })
        continue
      case 'permission_request':
        openPermissions.add(event.requestId)
        break
      case 'permission_resolved':
        openPermissions.delete(event.requestId)
        break
      case 'ask_user':
        openAsks.add(event.requestId)
        break
      case 'ask_user_resolved':
        openAsks.delete(event.requestId)
        break
      default:
        break
    }
    restored.push(event)
  }
  for (const requestId of openPermissions) {
    restored.push({ kind: 'permission_resolved', requestId })
  }
  for (const requestId of openAsks) {
    restored.push({ kind: 'ask_user_resolved', requestId })
  }
  return restored
}

/**
 * Replay the log's "last value wins" events into the state they describe.
 *
 * Entity kinds (`compaction`, `subagent`, `async_task`) are upserted by their
 * own id, exactly as the live path does: each event carries the entity's full
 * merged state, so the last one seen per id is the answer. The scalar kinds are
 * plain overwrites.
 */
export function foldRestoredState(events: readonly ChatEvent[]): RestoredSessionState {
  const state: RestoredSessionState = {
    modes: null,
    configOptions: [],
    commands: [],
    compactions: new Map(),
    subagents: new Map(),
    subagentParents: new Map(),
    asyncTasks: new Map(),
  }
  for (const event of events) {
    switch (event.kind) {
      case 'modes':
        state.modes = { available: event.available, current: event.current }
        break
      case 'mode_changed':
        // Only ever an update to modes that were announced first — a mode
        // change for a session with no advertised modes has nothing to name.
        if (state.modes) {
          state.modes.current = event.current
        }
        break
      case 'config_options':
        state.configOptions = event.options
        break
      case 'available_commands':
        state.commands = event.commands
        break
      case 'session_info':
        if (event.title) {
          state.title = event.title
        }
        break
      case 'usage':
        // A reading without a cost leaves the last recorded one standing, as
        // the live mirror does: a bare context reading is not a retraction.
        state.usage = {
          used: event.used,
          ...(event.size !== undefined ? { size: event.size } : {}),
          ...(event.cost ? { cost: event.cost } : state.usage?.cost ? { cost: state.usage.cost } : {}),
        }
        break
      case 'compaction':
        state.compactions.set(event.compaction.compactionId, { ...event.compaction })
        break
      case 'subagent':
        state.subagents.set(event.subagent.subagentSessionId, { ...event.subagent })
        break
      case 'subagent_event': {
        // A subagent spawned by a subagent is announced inside its parent's
        // step (see ChatEvent), at whatever depth the parent sits.
        let parentId = event.subagentSessionId
        let inner = event.event
        while (inner.kind === 'subagent_event') {
          parentId = inner.subagentSessionId
          inner = inner.event
        }
        if (inner.kind === 'subagent') {
          state.subagents.set(inner.subagent.subagentSessionId, { ...inner.subagent })
          state.subagentParents.set(inner.subagent.subagentSessionId, parentId)
        }
        break
      }
      case 'async_task':
        state.asyncTasks.set(event.task.asyncTaskId, { ...event.task })
        break
      case 'plan':
        state.plan = event.entries
        break
      default:
        break
    }
  }
  return state
}
