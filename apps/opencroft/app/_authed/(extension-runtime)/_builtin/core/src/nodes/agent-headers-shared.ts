// Request headers an agent node sends to an endpoint, read from its data: the
// speech endpoints (`ttsHeaders`, `asrHeaders`) and the provider endpoint of
// its profile (`endpointHeaders`). Shared by this extension's server and the
// host's session engine (acp-impl.ts in (agent)), so both resolve them the same
// way. No node builtins here, like every *-shared module.

import { mergeHeaders } from 'agent-client/endpoint-headers'

/** A header as the agent node stores it: the value typed, or `secret:NAME`. */
export interface HeaderPair {
  name: string
  value: string
}

/**
 * `custom` merged over `base`, each value resolved at request time by
 * `resolveValue` (the Secrets Store's: typed text as it is, `secret:NAME` from
 * the stores of the agent node's graph, throwing for a name no store holds).
 * Rows with no name are skipped. A custom header replaces one of `base` that
 * differs only in case, so a custom `Authorization` replaces a key's Bearer
 * shorthand.
 */
export async function resolveHeaders(
  custom: HeaderPair[] | undefined,
  resolveValue: (value: string) => Promise<string>,
  base: Record<string, string> = {},
): Promise<Record<string, string>> {
  let headers = base
  for (const entry of custom ?? []) {
    const name = entry?.name?.trim()
    if (name) {
      headers = mergeHeaders(headers, { [name]: await resolveValue(entry.value ?? '') })
    }
  }
  return headers
}

/**
 * Whether the profile's `endpointHeaders` are sent: only when its harness can
 * send headers at all and the profile names its endpoint itself (Base URL),
 * which is where a self-hosted model is reached. The Profile tab shows the
 * headers under the same condition, so what it shows is what is sent.
 */
export function profileSendsHeaders(harnessTakesHeaders: boolean, baseUrl: string | undefined): boolean {
  return harnessTakesHeaders && Boolean(baseUrl?.trim())
}
