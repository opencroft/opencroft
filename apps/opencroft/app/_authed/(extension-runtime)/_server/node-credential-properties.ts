// The properties each node type declares as holding a credential (`NodeCredentialProperties` in
// `@opencroft/server/secrets`), read from the server module of the extension that owns the type.

import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { getExtensionModule } from '@/app/_authed/(extension-runtime)/_server/loader'

const NONE: ReadonlySet<string> = new Set()

async function declaredBy(type: string): Promise<ReadonlySet<string>> {
  const parsed = parseType(type)
  if (!parsed) {
    return NONE
  }
  try {
    const declared = (await getExtensionModule(parsed.extensionId)).nodeCredentialProperties?.[parsed.bare]
    return declared ? new Set(declared) : NONE
  } catch {
    // An extension that is not installed or does not load declares nothing; why it does not load
    // is reported where it is activated. Its nodes are still read under the name rules.
    return NONE
  }
}

/** The declared credential properties of each of `types`, loading each type's extension once. */
export async function credentialPropertiesOf(types: Iterable<unknown>): Promise<Map<string, ReadonlySet<string>>> {
  const distinct = [...new Set(types)].filter((type): type is string => typeof type === 'string')
  return new Map(await Promise.all(distinct.map(async (type) => [type, await declaredBy(type)] as const)))
}
