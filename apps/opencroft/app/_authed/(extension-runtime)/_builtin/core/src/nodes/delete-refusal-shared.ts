// What a checked delete answers, shared by the server that refuses (the Secrets
// Store's and the Key Store's) and the inspectors that show the refusal.

/** A node or App that still names what is being deleted. */
export interface NodeReference {
  /** The node's id, or the App's address (`<space>.<slug>`). */
  nodeId: string
  /** The node's type; `app:<type>` for an App. */
  nodeType?: string
  /** The node's own `name`: what a person recognises it by. */
  nodeName?: string
}

export interface DeleteRefusal {
  references: NodeReference[]
  message: string
}

/** Deleted, or refused with the nodes that still name it. */
export type DeleteOutcome = { deleted: string } | { refused: DeleteRefusal }

/** Renamed to the name given, or refused with the nodes that still name the old one. */
export type RenameOutcome = { renamed: string } | { refused: DeleteRefusal }

/** How a person recognises a node that names what is being deleted. */
export function describeReference(ref: NodeReference): string {
  return ref.nodeName ?? ref.nodeType ?? ref.nodeId
}
