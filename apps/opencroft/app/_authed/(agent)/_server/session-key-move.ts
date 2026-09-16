// Moving a live session from one session key to another.
//
// A session key is not a label. It is the identity every layer files a session
// under: the durable pointer that survives a restart, the in-process tab map,
// agent-client's own live registry, and the transient compaction job. A caller
// that re-mints a key — because the thing the key is derived from was renamed —
// has to move all of them, and moving only some of them fails SILENTLY: the
// conversation and the agent process are still there, addressed by a name
// nothing looks up any more, and the next message opens a fresh empty session
// beside the real one.
//
// This module is that move, and it knows nothing about WHY a key changed. It
// takes pairs of strings. Whatever derives them — a renamed group chat, a
// renamed thread — is the caller's business.
//
// ── The ordering, which is the whole design ──────────────────────────────
//
// There is no transaction spanning a settings row, an in-memory map and the
// database row that names the key, so "all of it or none of it" is not
// available. What IS available is making every intermediate state harmless, and
// that is what the two halves buy:
//
//   stageSessionKeyMoves    BEFORE the caller commits the rename. Copies the
//                           durable pointer onto the new key. Afterwards both
//                           keys resolve to the same session, and since nothing
//                           addresses the new key yet, the duplicate is inert.
//
//   settleSessionKeyMoves   AFTER the commit, when the new key is the address
//                           and the old one is nobody's. Drops the old durable
//                           entries and repoints everything held in memory.
//
// So the invariant a reader should check this file against is: **the new key
// resolves to the right session before anything can ask it to.** Interrupted
// between the halves, the residue is a stale entry under an unused address —
// never a thread pointing at nothing.
//
// The in-memory half needs no crash story of its own. A process that dies loses
// `tabSessions`, agent-client's registry and the compaction jobs together, and
// they are all rebuilt from the durable pointer on the next open — so the one
// state they must never be left in, half-moved while the process keeps running,
// is exactly the one `settleSessionKeyMoves` avoids by not throwing.

import { tabSessions } from '@/app/_authed/(agent)/_server/acp-impl'
import { copyTabKeys, dropTabKeys, type TabKeyMove } from '@/app/_authed/(agent)/_server/acp-session-store'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { moveQueueEntries } from '@/app/_authed/(agent)/_server/queue-store'
import { moveSessionEvents } from '@/app/_authed/(agent)/_server/session-event-store'
import { renameCompactJobKey } from '@/app/_authed/(extension-runtime)/_server/stream'

export type { TabKeyMove }

/** Drops no-ops so a caller can pass a whole chat's threads without filtering. */
function realMoves(moves: readonly TabKeyMove[]): TabKeyMove[] {
  return moves.filter((move) => move.from && move.to && move.from !== move.to)
}

/**
 * Make every `to` key resolve to the session its `from` key resolves to,
 * without disturbing `from`. Call this BEFORE committing whatever makes `to`
 * the real address.
 *
 * Throws if the durable copy fails, and that is deliberate: the caller has not
 * committed anything yet, so a failure here means the rename simply does not
 * happen — which is the outcome to want when the session pointer could not be
 * carried across.
 */
export async function stageSessionKeyMoves(moves: readonly TabKeyMove[]): Promise<void> {
  await copyTabKeys(realMoves(moves))
}

/**
 * Finish the move: forget the old durable entries and repoint every in-memory
 * registry at the new key. Call this AFTER the rename has committed.
 *
 * NEVER THROWS. It runs past the point of no return — the rename is already
 * durable — so a failure here must not be reported to the caller as a failed
 * rename it might retry or, worse, try to undo. Each step is independent and
 * each logs its own failure, because a durable entry left behind and a live
 * session still answering to the old key are different problems with different
 * consequences, and a single swallowed error would hide which one happened.
 */
export async function settleSessionKeyMoves(moves: readonly TabKeyMove[]): Promise<void> {
  const real = realMoves(moves)
  if (real.length === 0) {
    return
  }
  // Copy once more before dropping. Between staging and here the old key was
  // still the live one, so an ordinary prompt landing in that window updates
  // the OLD pointer -- `prompted` flipping to true on a session's first
  // message is exactly that write. Re-copying picks it up; dropping without
  // would discard it and let the next open re-attach session-init context the
  // agent has already been given.
  await copyTabKeys(real).catch((error) => {
    console.error('[session-key-move] failed to re-copy the durable entries before retiring the old keys', error)
  })
  // The durable queue is addressed by the same key and is NOT a settings row,
  // so it moves on its own. Left behind, a message still waiting for the agent
  // would be unreachable under a name nothing looks up again -- somebody's
  // message, silently never delivered.
  await moveQueueEntries(real).catch((error) => {
    console.error('[session-key-move] failed to carry the durable queue onto the new keys', error)
  })
  // The recorded transcript is addressed by the same key and is its own table
  // too. Left behind, the conversation's whole history is unreachable, and the
  // next open silently falls back to the harness's lossy replay -- which reads
  // as a rename having eaten the subagents out of a chat.
  await moveSessionEvents(real).catch((error) => {
    console.error('[session-key-move] failed to carry the recorded transcript onto the new keys', error)
  })
  for (const { from, to } of real) {
    // The in-process tab -> session pointer. Without this the reaper's unload
    // and every "stop this process" control address a key the map has never
    // heard of and quietly do nothing, leaving a process alive that no screen
    // can reach.
    const entry = tabSessions.get(from)
    if (entry) {
      tabSessions.set(to, entry)
      tabSessions.delete(from)
    }
    // agent-client's own live registry. This is what `listSessions` publishes
    // and what the status/usage reads match against, so a session left behind
    // here reads as offline with an empty context ring while it is in fact
    // running.
    agentClient.renameSessionKey(from, to)
    // A compaction already in flight. Nothing is lost if this is missed — the
    // compaction still completes — but its status poll would report
    // 'never-requested' for a job that is plainly running.
    renameCompactJobKey(from, to)
  }
  await dropTabKeys(real).catch((error) => {
    console.error('[session-key-move] failed to drop the old durable entries', error)
  })
}
