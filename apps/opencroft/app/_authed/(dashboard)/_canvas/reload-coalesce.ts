export interface ReloadCoalesceState {
  inFlight: boolean
  pending: boolean
  // The closure from the MOST RECENT call that arrived while one was already
  // in flight. A trailing run must reflect what the caller wants NOW, not
  // what it wanted when the in-flight run started -- each closure captures
  // its own point-in-time state (e.g. flow-editor.tsx's reload closure
  // captures `slug`), so re-running the first one after several calls have
  // queued would apply a since-superseded caller's state.
  nextRun: (() => Promise<void>) | null
}

/**
 * Runs `run` at most once at a time against `state`. A call that arrives
 * while one is already in flight doesn't start a second, concurrent run --
 * it marks `pending`, records its own closure as `nextRun`, and returns; the
 * in-flight run notices before it exits and loops once more, running the
 * LATEST queued closure rather than the one it started with. A burst of
 * calls during one run collapses into a single trailing extra run of the
 * last caller's closure, not one run per call, and no two runs ever execute
 * their bodies concurrently.
 *
 * Exists because the SSE-triggered extension reload in flow-editor.tsx clears
 * and repopulates the shared, non-transactional `extensionRegistry` singleton
 * -- two overlapping passes interleaving their clear()/register() calls is
 * the same class of race `loader.ts`'s `getExtensionModule` already hit and
 * fixed server-side (single-flight per extensionId), reproduced live there as
 * two module instances both `load()`-ing, the loser's state being whatever it
 * managed before losing.
 */
export async function coalesceReload(state: ReloadCoalesceState, run: () => Promise<void>): Promise<void> {
  if (state.inFlight) {
    state.pending = true
    state.nextRun = run
    return
  }
  state.inFlight = true
  let toRun = run
  do {
    state.pending = false
    await toRun()
    if (state.nextRun) {
      toRun = state.nextRun
      state.nextRun = null
    }
  } while (state.pending)
  state.inFlight = false
}
