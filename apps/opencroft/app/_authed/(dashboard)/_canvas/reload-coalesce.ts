export interface ReloadCoalesceState {
  inFlight: boolean
  pending: boolean
}

/**
 * Runs `run` at most once at a time against `state`. A call that arrives
 * while one is already in flight doesn't start a second, concurrent run --
 * it marks `pending` and returns; the in-flight run notices before it exits
 * and loops once more. A burst of calls during one run collapses into a
 * single trailing extra run, not one per call, and no two runs ever execute
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
    return
  }
  state.inFlight = true
  do {
    state.pending = false
    await run()
  } while (state.pending)
  state.inFlight = false
}
