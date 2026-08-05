// Safe for both server and client — no runtime imports of Node-only or React APIs.

export interface TypeIdOwner {
  extensionId: string
  typeIds: string[]
}

// The manifest/declaration shape every caller of manifestOwners has: an id and
// an optional list of node-shaped entries carrying a typeId. Structural, not
// tied to ExtensionManifest or ExtensionDeclaration specifically, since
// callers on the client and server sides use different concrete types for
// otherwise the same shape.
interface OwnerSource {
  id: string
  nodes?: Array<{ typeId: string }>
}

/** Flattens a manifest/declaration list into the shape assertUniqueNodeTypeIds takes. */
export function manifestOwners(sources: OwnerSource[]): TypeIdOwner[] {
  return sources.map((source) => ({
    extensionId: source.id,
    typeIds: (source.nodes ?? []).map((node) => node.typeId),
  }))
}

/**
 * Throws if any node type id is declared by more than one extension. A type id
 * belongs to exactly one extension — the alternative (later registration
 * silently wins) makes which implementation actually runs a function of load
 * order, and nothing says so until the wrong one's behavior turns up
 * somewhere else entirely.
 */
export function assertUniqueNodeTypeIds(owners: TypeIdOwner[]): void {
  const claimedBy = new Map<string, Set<string>>()
  for (const { extensionId, typeIds } of owners) {
    for (const typeId of typeIds) {
      const claimants = claimedBy.get(typeId)
      if (claimants) {
        claimants.add(extensionId)
      } else {
        claimedBy.set(typeId, new Set([extensionId]))
      }
    }
  }
  const collisions = [...claimedBy.entries()].filter(([, ids]) => ids.size > 1)
  if (collisions.length === 0) {
    return
  }
  const detail = collisions.map(([typeId, ids]) => `"${typeId}" claimed by ${[...ids].join(', ')}`).join('; ')
  throw new Error(`Node type id collision — a type id may be declared by only one extension: ${detail}`)
}
