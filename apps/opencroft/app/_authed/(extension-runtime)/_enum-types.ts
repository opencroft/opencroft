// The enums the extensions declare: their handle types that carry `cases`.
// The host answers the values module's `EnumCasesOf` from them, on the server
// from the manifests and on the client from the loaded declarations, so both
// know the same enums.
//
// Safe for both server and client — no runtime imports.

import type { EnumCasesOf, ValueOption } from '@opencroft/core/values'

interface DeclaredHandleType {
  id: string
  cases?: readonly ValueOption[]
}

/** The `EnumCasesOf` of the enums among `handleTypes` (qualified). */
export function enumCasesFrom(handleTypes: Iterable<DeclaredHandleType>): EnumCasesOf {
  const enums = new Map<string, readonly ValueOption[]>()
  for (const handleType of handleTypes) {
    if (handleType.cases) {
      enums.set(handleType.id, handleType.cases)
    }
  }
  return (type) => enums.get(type)
}

/** The `EnumCasesOf` of the enums every one of `manifests` declares. */
export function enumCasesOfManifests(
  manifests: readonly { handleTypes?: readonly DeclaredHandleType[] }[],
): EnumCasesOf {
  return enumCasesFrom(manifests.flatMap((manifest) => manifest.handleTypes ?? []))
}
