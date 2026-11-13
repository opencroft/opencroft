// That the directory of spaces and apps changed: a space or an app was added,
// removed, renamed, moved or otherwise changed what a listing shows of it, or a
// system sender's grant into a chat moved which spaces it sees. Announced by
// the writes themselves, whoever made them, and heard by extensions through
// `spaces.subscribe` / `apps.subscribe`.
//
// The announcement carries no content, only what kind of thing changed and
// how. What changed is read back through the viewer-gated listings, so a
// subscriber learns nothing here that those reads would not tell it.

/** What changed: a space, an app, or which spaces a system sender's grants reach. */
export type DirectoryChangeSubject = 'space' | 'app' | 'access'

/** How it changed. `moved` is an app transferred to another space; `updated` is any other change a listing shows (a space's icon, an app's type). */
export type DirectoryChangeKind = 'added' | 'removed' | 'renamed' | 'moved' | 'updated'

export interface DirectoryChange {
  subject: DirectoryChangeSubject
  change: DirectoryChangeKind
}

const listeners = new Set<(change: DirectoryChange) => void | Promise<void>>()

/**
 * Tell every subscriber about `change`. Called after the write has landed.
 * Subscribers are extension code, so each is called after the write's own
 * call returns, and a throwing or rejecting one is logged without reaching
 * the write or the other subscribers.
 */
export function announceDirectoryChange(change: DirectoryChange): void {
  for (const listener of listeners) {
    void Promise.resolve()
      .then(() => listener(change))
      .catch((error: unknown) => {
        console.error('[directory] a change listener failed', error)
      })
  }
}

/** Called once per announced change. Returns the unsubscribe. */
export function subscribeDirectoryChanges(listener: (change: DirectoryChange) => void | Promise<void>): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
