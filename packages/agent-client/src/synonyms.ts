// Shared machinery for "harnesses say it their way, we say it ours".
//
// Every agent names the same things differently — `xhigh` for what we call
// Extra, `dontAsk` for what we call Reject Edits, `default` for what we call
// Manual Edits. Rather than teach each surface every spelling, each vocabulary
// (see session-modes.ts, session-effort.ts) declares its own canonical values
// and REGISTERS the wire spellings that mean them. Everything downstream then
// operates on our values only.
//
// Registrations are written canonical-first — `{ 'reject-edits': ['dontAsk'] }`
// — because that is the direction the knowledge actually runs: you know what
// you mean, and you are listing what an agent might call it. The reverse lookup
// is derived here so the two can never disagree.

/** Wire spellings that mean one canonical value, keyed by that value. */
export type SynonymRegistration<T extends string> = Partial<Record<T, string[]>>

/**
 * Comparison form for a wire value: case and separators carry no meaning across
 * agents (`acceptEdits`, `accept_edits` and `accept-edits` are one thing), so
 * they are stripped before matching. A registration therefore only needs the
 * spellings that differ in LETTERS, not in punctuation.
 */
export function normalizeSynonym(value: string): string {
  return value.toLowerCase().replace(/[-_\s]/g, '')
}

export interface SynonymResolver<T extends string> {
  /**
   * Our value for a wire value, or undefined when nothing recognises it.
   *
   * Undefined is a normal answer, never a failure: an unrecognised value is
   * still real and still selectable, and a caller should fall back to the
   * agent's own wording rather than hide it or guess. Guessing is the one
   * outcome worth avoiding — a wrong icon asserts a behaviour nobody verified.
   *
   * `adapterId` is consulted first, so an agent that reuses a common word for
   * an uncommon behaviour can be corrected in one place without that
   * correction leaking to every other agent.
   */
  resolve(adapterId: string, value: string): T | undefined
}

/**
 * Build a resolver from canonical-first registrations.
 *
 * Every canonical value is implicitly its own synonym, so an agent already
 * speaking our language needs no registration at all.
 */
export function createSynonymResolver<T extends string>(
  canonical: readonly T[],
  shared: SynonymRegistration<T>,
  perAdapter: Record<string, SynonymRegistration<T>> = {},
): SynonymResolver<T> {
  const flatten = (registration: SynonymRegistration<T>, seed: readonly T[] = []): Map<string, T> => {
    const lookup = new Map<string, T>()
    for (const value of seed) {
      lookup.set(normalizeSynonym(value), value)
    }
    for (const [value, spellings] of Object.entries(registration) as [T, string[]][]) {
      for (const spelling of spellings) {
        lookup.set(normalizeSynonym(spelling), value)
      }
    }
    return lookup
  }

  const sharedLookup = flatten(shared, canonical)
  const adapterLookups = new Map<string, Map<string, T>>()
  for (const [adapterId, registration] of Object.entries(perAdapter)) {
    adapterLookups.set(adapterId, flatten(registration))
  }

  return {
    resolve(adapterId: string, value: string): T | undefined {
      const key = normalizeSynonym(value)
      return adapterLookups.get(adapterId)?.get(key) ?? sharedLookup.get(key)
    },
  }
}
