// What a client and the collaboration server agree on whatever kind of
// document they share, beyond the Yjs sync protocol itself.

/** The collaboration server's socket path. */
export const COLLAB_SOCKET_PATH = '/api/ws/collab'

/**
 * Why a connection was refused when the client's copy of the document comes
 * from a lineage the server no longer holds. The client must drop that copy
 * and connect again with a fresh one: syncing it would merge two histories of
 * the same document and duplicate everything in it.
 */
export const STALE_LINEAGE_REASON = 'stale-lineage'

/** Where a client opens a shared document: its name, and the lineage to present as its token. */
export interface CollabSession {
  docName: string
  lineage: string
}

/** The collaboration socket on the page's own host. */
export function collabSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${COLLAB_SOCKET_PATH}`
}
