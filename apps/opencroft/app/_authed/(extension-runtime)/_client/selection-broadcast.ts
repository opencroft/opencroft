// A selection shared between the windows of one browser.
//
// A reader can keep the chat in one window and the canvas or a document in
// another. Each window's selection scope publishes what its own surface
// selects on a `BroadcastChannel` (same origin, same browser profile, no
// server), and every scope of the same space shows the newest selection any
// window made, exactly as it shows its own.
//
// THE RULES, each one decided here and nowhere else:
//
// - A selection belongs to the space its window shows. A message for another
//   space is ignored.
// - The newest event wins, whichever window made it. A clear is an event too,
//   so it carries a time like a selection does. Within one window the order
//   of its posts decides (see `nextRemoteSelection`).
// - A window clears only what it published itself: a clear from a window
//   whose selection is not the one shown changes nothing.
// - A window answers a newcomer's `hello` with its OWN selection, never with
//   one it received. Nothing received is ever posted again, so two windows
//   cannot echo a selection back and forth.
// - Messages carry the same fields the composer would send for a local
//   selection (its label and the quoted content), and nothing else.
//
// No React and no host imports, so the rules are testable on their own with a
// fake channel and a fake clock.

import type { UserSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'

/** The one channel every window's scope talks on. */
export const SELECTION_CHANNEL = 'opencroft.selection'

/** A window's selection as of a moment. `selection: null` is a clear. */
export interface StampedSelection {
  selection: UserSelection | null
  at: number
}

/** A selection another window published, with the window that published it. */
export interface RemoteSelection extends StampedSelection {
  source: string
}

type SelectionMessage =
  | { kind: 'selection'; space: string; source: string; at: number; selection: UserSelection | null }
  | { kind: 'hello'; space: string; source: string }

/** The transport: post to every other listener, and stop. */
export interface SelectionPort {
  post: (message: unknown) => void
  close: () => void
}

/** Opens a port that hands every message it receives to `onMessage`. */
export type OpenSelectionPort = (onMessage: (data: unknown) => void) => SelectionPort

export const openBroadcastPort: OpenSelectionPort = (onMessage) => {
  const channel = new BroadcastChannel(SELECTION_CHANNEL)
  channel.onmessage = (event) => onMessage(event.data)
  return {
    post: (message) => channel.postMessage(message),
    close: () => channel.close(),
  }
}

let windowSource: string | undefined

/**
 * This window's id on the channel, made on first use and the same for every
 * scope in the window. Keyed by window rather than by scope because a channel
 * object skips only its own posts: another scope in the same document would
 * receive them, and two scopes on one page must not mirror each other.
 */
export function thisWindowSource(): string {
  windowSource ??=
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return windowSource
}

function isUserSelection(value: unknown): value is UserSelection {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.label === 'string' && typeof candidate.content === 'string'
}

/** A message as posted by `openSelectionBridge`, or null for anything else on the channel. */
export function parseSelectionMessage(data: unknown): SelectionMessage | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const message = data as Record<string, unknown>
  if (typeof message.space !== 'string' || typeof message.source !== 'string') {
    return null
  }
  if (message.kind === 'hello') {
    return { kind: 'hello', space: message.space, source: message.source }
  }
  if (
    message.kind === 'selection' &&
    typeof message.at === 'number' &&
    Number.isFinite(message.at) &&
    (message.selection === null || isUserSelection(message.selection))
  ) {
    const selection =
      message.selection === null ? null : { label: message.selection.label, content: message.selection.content }
    return { kind: 'selection', space: message.space, source: message.source, at: message.at, selection }
  }
  return null
}

/**
 * The remote selection after `incoming` arrives.
 *
 * Another window's selection replaces the current one unless it is older. The
 * shown window's own message always replaces its earlier one, whatever its
 * time: one window's posts arrive in the order it made them, and a window that
 * comes back (restored from the back-forward cache, or its scope remounted)
 * offers its selection again under the time it was first made, which is older
 * than the clear it posted on the way out. A clear applies only when it comes
 * from the window whose selection is shown.
 */
export function nextRemoteSelection(
  current: RemoteSelection | null,
  incoming: RemoteSelection,
): RemoteSelection | null {
  if (current && incoming.source !== current.source && incoming.at < current.at) {
    return current
  }
  if (incoming.selection === null && current?.source !== incoming.source) {
    return current
  }
  return incoming
}

/** What the composer shows: the newer of this window's event and the other windows'. A tie goes to this window. */
export function shownSelection(local: StampedSelection | null, remote: RemoteSelection | null): UserSelection | null {
  if (!remote) {
    return local?.selection ?? null
  }
  if (!local || remote.at > local.at) {
    return remote.selection
  }
  return local.selection
}

export interface SelectionBridge {
  /** This window's selection changed. Posts it, a clear included. */
  publish: (local: StampedSelection | null) => void
  /** Ask the other windows for their selections, and offer this window's. */
  announce: () => void
  /** Forget what the other windows offered, then announce: for a window that missed their messages. */
  rejoin: () => void
  /** This window stops offering its selection: the windows showing it clear it. */
  leave: () => void
  close: () => void
}

export interface SelectionBridgeOptions {
  /** The space this window shows. */
  space: string
  /** This window's id on the channel; see `thisWindowSource`. */
  source: string
  open: OpenSelectionPort
  now: () => number
  /** Called with the remote selection each time it changes. */
  onRemote: (remote: RemoteSelection | null) => void
  /** This window's selection when the bridge opens; offered by `announce`, not posted on opening. */
  local: StampedSelection | null
}

export function openSelectionBridge({
  space,
  source,
  open,
  now,
  onRemote,
  local: initial,
}: SelectionBridgeOptions): SelectionBridge {
  let local = initial
  let remote: RemoteSelection | null = null

  const postLocal = () => {
    if (local) {
      port.post({
        kind: 'selection',
        space,
        source,
        at: local.at,
        selection: local.selection,
      } satisfies SelectionMessage)
    }
  }

  const receive = (data: unknown) => {
    const message = parseSelectionMessage(data)
    if (!message || message.space !== space || message.source === source) {
      return
    }
    if (message.kind === 'hello') {
      if (local?.selection) {
        postLocal()
      }
      return
    }
    const next = nextRemoteSelection(remote, { source: message.source, at: message.at, selection: message.selection })
    if (next !== remote) {
      remote = next
      onRemote(next)
    }
  }

  const port = open(receive)

  const announce = () => {
    port.post({ kind: 'hello', space, source } satisfies SelectionMessage)
    if (local?.selection) {
      postLocal()
    }
  }

  return {
    publish: (next) => {
      if (next === local) {
        return
      }
      local = next
      postLocal()
    },
    announce,
    rejoin: () => {
      if (remote) {
        remote = null
        onRemote(null)
      }
      announce()
    },
    leave: () => {
      if (local?.selection) {
        port.post({ kind: 'selection', space, source, at: now(), selection: null } satisfies SelectionMessage)
      }
    },
    close: () => port.close(),
  }
}
