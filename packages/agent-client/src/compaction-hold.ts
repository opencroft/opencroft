/**
 * Which of a session's context compactions are still running, as the live
 * `compaction_update` stream reports them — the fact mid-turn delivery is held
 * on. A steer pre-empts the generation that is running, and during a
 * compaction that generation is the one writing the summary.
 *
 * Present only while at least one compaction is `in_progress`; a session that
 * is not compacting has no hold at all, so "is it compacting" is a presence
 * check rather than a scan.
 *
 * The backstop covers a harness that opens a compaction and never reports its
 * end while the turn keeps running. It is NOT a heartbeat timeout: a compacting
 * harness may say nothing between its one `in_progress` and its terminal update
 * for as long as the summary takes to write, so the window is long, and every
 * update or summary chunk for a held compaction starts it again. The turn
 * boundary is the ordinary safety net (the engine drops the hold when the turn
 * settles); the backstop is only for a turn that outlives a lost update.
 */
export interface CompactionHold {
  readonly compactionIds: ReadonlySet<string>
  readonly backstop: ReturnType<typeof setTimeout>
}

export const COMPACTION_HOLD_BACKSTOP_MS = 10 * 60_000

/**
 * The hold after one live signal about compaction `compactionId`: a status
 * from `compaction_update`, or `undefined` for a summary chunk (progress, no
 * change of state). Returns the hold to keep, or `undefined` once nothing is in
 * progress any more. The previous hold's backstop is always cleared; the
 * returned one, if any, is armed afresh and calls `expire` when it runs out.
 */
export function nextCompactionHold(
  hold: CompactionHold | undefined,
  compactionId: string,
  status: string | undefined,
  expire: () => void,
): CompactionHold | undefined {
  const compactionIds = new Set(hold?.compactionIds)
  if (status === 'in_progress') {
    compactionIds.add(compactionId)
  } else if (status !== undefined) {
    // Any other status is the compaction leaving `in_progress`: the defined
    // terminal ones, and anything a newer protocol adds, which must not leave
    // delivery held forever.
    compactionIds.delete(compactionId)
  } else if (!compactionIds.has(compactionId)) {
    // A chunk for a compaction that is not held moves nothing.
    return hold
  }
  endCompactionHold(hold)
  if (compactionIds.size === 0) {
    return undefined
  }
  const backstop = setTimeout(expire, COMPACTION_HOLD_BACKSTOP_MS)
  // A held delivery is not a reason to keep the process alive.
  backstop.unref?.()
  return { compactionIds, backstop }
}

/** Disarm a hold that is being dropped. */
export function endCompactionHold(hold: CompactionHold | undefined): void {
  if (hold) {
    clearTimeout(hold.backstop)
  }
}
