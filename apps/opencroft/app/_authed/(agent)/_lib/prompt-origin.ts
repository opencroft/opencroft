// What a BROWSER is allowed to say about who a message is from.
//
// Client-safe by construction: types plus one constant, no server imports, so
// both `use-acp-session` and the server functions can read it.

import type { PromptOrigin } from 'agent-client/types'

/**
 * The origin as it crosses this app's own wire, browser -> `promptLocal`.
 *
 * One variant, and that is the entire point: `reader` NAMES NOBODY. It says
 * "whoever is signed in on this request", and `promptLocalImpl` turns it into a
 * real display name server-side, where the session is already known.
 *
 * Deliberately NOT `PromptOrigin | { kind: 'reader' }`. That union looks like a
 * harmless superset and hands the browser back exactly what this exists to
 * remove: `{ kind: 'message', sender: <anyone> }` would be quoted verbatim as the
 * author, in the transcript and in every agent's reading of who said what.
 * Attribution is what this change introduces; a wire that can state it is a
 * wire that can forge it.
 */
export type WirePromptOrigin = { kind: 'reader' }

/**
 * What `promptLocalImpl` accepts. Server-side callers (the group-chat model,
 * the extension-runtime stream) already know their own truth and pass a
 * concrete `PromptOrigin`; only the browser door passes `reader`.
 */
export type PromptOriginInput = PromptOrigin | WirePromptOrigin

/**
 * The only origin a client can state. A constant so no call site invents its
 * own — there is nothing to get wrong, which is the property worth keeping.
 */
export const READER_ORIGIN: WirePromptOrigin = { kind: 'reader' }
