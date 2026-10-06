// What a client and the collaboration server agree on about a graph's
// document, beyond what they agree on for every document
// (`@/lib/collab-protocol`).

import type { CollabSession } from '@/lib/collab-protocol'

const PREFIX = 'graph'

/** The collaboration server's name for a graph's document. */
export function graphDocName(graphId: string): string {
  return `${PREFIX}:${graphId}`
}

/** The graph id a document name refers to, or null for another kind of document. */
export function graphIdOfDocName(name: string): string | null {
  return name.startsWith(`${PREFIX}:`) ? name.slice(PREFIX.length + 1) : null
}

export const GRAPH_DOC_PREFIX = PREFIX

/** Where a client opens a live graph. */
export type LiveGraphSession = CollabSession

/** Who changed a graph, as the change is announced to clients. */
export interface GraphWriteOrigin {
  kind: 'user' | 'agent' | 'extension' | 'system'
  name: string
}

/**
 * Sent to every client of a graph's document after a server-side write, since
 * a Yjs update itself does not say who made it.
 */
export interface GraphChangedMessage {
  type: 'graph-changed'
  origin: GraphWriteOrigin
  nodeIds: string[]
  edgeIds: string[]
}
