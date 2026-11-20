// How a terminal is named wherever it is shown: the Terminal Selector, a
// TerminalRef, a router's route, a mention in text, an extension's own list
// (through HandleInfo.title). Decided once, here, from what the host knows of
// the terminal's owner and its handle. Host-free, so both the handle listing
// and the reference describer use it and it is tested on its own.

/** A source handle as its owner declares it: enough to tell which declaration a live id belongs to. */
export interface DeclaredSourceHandle {
  id: string
  handleType: string
  label?: string
  dynamic?: boolean
}

/**
 * Which of its owner's terminals `handleId` is, when that needs saying; ''
 * when the owner's name says it all. The App's own name for the handle wins
 * (a Git worktree's "repo · name"). Otherwise a dynamic handle is told by its
 * live remainder (an Application's container), and a static one by its label,
 * but only when the owner declares several of its type: a lone terminal's
 * label would only repeat "Terminal". A handle none of the owner's
 * declarations matches is told by its id; an owner whose declarations are not
 * known (its extension is gone) is left to its own name.
 */
export function terminalDetail(declared: readonly DeclaredSourceHandle[], handleId: string, appLabel?: string): string {
  if (appLabel) {
    return appLabel
  }
  const handle = declared.find((h) => (h.dynamic ? handleId.startsWith(h.id) : h.id === handleId))
  if (!handle) {
    return declared.length > 0 ? handleId : ''
  }
  if (handle.dynamic) {
    return handleId.slice(handle.id.length)
  }
  const plain = declared.filter((h) => !h.dynamic && h.handleType === handle.handleType)
  return plain.length > 1 ? (handle.label ?? handle.id) : ''
}

/**
 * A terminal's one name, from its owner and `terminalDetail`.
 *
 * - A node's terminal is the node's name, followed by which of its terminals it
 *   is when that is something else: "Agent box · agent-container",
 *   "Docker · postgres". A container named like its node adds nothing, so an
 *   Application "agent-container" running "agent-container" is just that.
 * - An App's terminal is what the App calls it ("my-repo · main"), the App
 *   being the place it is listed or reached through; one the App gives no name
 *   of its own is the App's name.
 */
export function terminalTitle(owner: { kind: 'node' | 'app'; name: string }, detail: string): string {
  if (!detail || detail === owner.name) {
    return owner.name
  }
  return owner.kind === 'app' ? detail : `${owner.name} · ${detail}`
}
