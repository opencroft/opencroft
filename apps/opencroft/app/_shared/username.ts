/**
 * What a username is, stated once.
 *
 * A username identifies an ACCOUNT. It is not a name and not a credential:
 * the display name says what to call someone and stays editable and
 * non-unique; the email stays the login. This is the third thing -- the stable
 * handle a durable reference can be written against and still resolve years
 * later.
 *
 * Both kinds of account share it. A person and an agent draw from one
 * identifier space, and the `agent.` prefix is what keeps them from colliding
 * by construction rather than by convention: agents are inside it, people are
 * refused it.
 *
 * This module is the single place that grammar lives. It is deliberately
 * dependency-free and isomorphic so the account screen, the server that
 * accepts a change, and the message layer that stamps and resolves one all
 * read the SAME rule -- two copies of an identifier grammar is how two layers
 * start disagreeing about what a valid author looks like.
 */

/** The prefix that marks an agent, and that no person may take.
 *
 * Carries its own dot, so `agent.alice` is an ordinary username in the ordinary
 * alphabet rather than a specially-shaped string. A person may still hold
 * `agent` -- it does not begin with `agent.`, so it cannot be mistaken for one.
 */
export const AGENT_USERNAME_PREFIX = 'agent.'

/**
 * The prefix that marks the application itself, and that no person may take.
 *
 * A message can genuinely originate from the system rather than from anybody:
 * a webhook arriving, a schedule firing. Attributing one of those to a tool's
 * name, or to an agent that did not send it, are both untrue, so the system
 * gets an identifier of its own rather than borrowing somebody's.
 *
 * It is NOT a fallback for "we could not work out who sent this". An
 * originator that cannot be established is a refusal, never this -- the moment
 * this becomes the bucket for unknown senders, impersonation returns as
 * attribution-by-omission and the field is worth exactly as much as a tool
 * name. What follows the prefix names the KIND of trigger, so the record says
 * which part of the application spoke.
 */
export const SYSTEM_USERNAME_PREFIX = 'system.'

// Lowercase letters, digits and dots. Uppercase is not accepted at all rather
// than folded, which is why uniqueness elsewhere is a plain comparison and
// never a case-insensitive one.
const USERNAME_PATTERN = /^[a-z0-9.]+$/

/** Why a username was refused, so every surface can say the same thing. */
export type UsernameRefusal =
  | 'empty'
  | 'bad-characters'
  /** A person tried to take the agent namespace. */
  | 'reserved-prefix'
  /** An agent username with nothing after the prefix identifies no agent. */
  | 'prefix-only'

export interface UsernameCheck {
  ok: boolean
  refusal?: UsernameRefusal
}

/** Whether this username belongs to the agent namespace. */
export function isAgentUsername(value: string): boolean {
  return value.startsWith(AGENT_USERNAME_PREFIX)
}

/** Whether this username belongs to the application itself. */
export function isSystemUsername(value: string): boolean {
  return value.startsWith(SYSTEM_USERNAME_PREFIX)
}

/**
 * Is this a username the given kind of account may hold?
 *
 * `kind` is required rather than defaulted: the reserved-prefix rule is the
 * whole reason the two spaces cannot collide, and a default would let a call
 * site skip the decision by accident and check the wrong rule.
 *
 * Says nothing about whether the username is FREE -- that is a property of the
 * store and not of the string, so it cannot be answered here.
 */
export function checkUsername(value: string, kind: 'user' | 'agent'): UsernameCheck {
  if (value.length === 0) {
    return { ok: false, refusal: 'empty' }
  }
  if (!USERNAME_PATTERN.test(value)) {
    return { ok: false, refusal: 'bad-characters' }
  }
  if (kind === 'user' && (isAgentUsername(value) || isSystemUsername(value))) {
    return { ok: false, refusal: 'reserved-prefix' }
  }
  if (kind === 'agent' && value === AGENT_USERNAME_PREFIX) {
    return { ok: false, refusal: 'prefix-only' }
  }
  return { ok: true }
}

/**
 * What to tell someone whose username was refused.
 *
 * Here rather than in a component so the account screen and an API refusal
 * give the same answer, and so the wording of a rule lives beside the rule.
 */
export function usernameRefusalMessage(refusal: UsernameRefusal): string {
  switch (refusal) {
    case 'empty':
      return 'A username cannot be empty.'
    case 'bad-characters':
      return 'A username can use lowercase letters, digits and dots only — no spaces or capitals.'
    case 'reserved-prefix':
      return `Usernames beginning with "${AGENT_USERNAME_PREFIX}" identify agents and cannot be taken.`
    case 'prefix-only':
      return `"${AGENT_USERNAME_PREFIX}" needs a name after it.`
  }
}

/**
 * A first username derived from a display name, for backfilling an account
 * that predates this field and for seeding a newly created one.
 *
 * Derivation happens HERE AND ONLY HERE, once, at the moment an account first
 * needs a handle. From then on the two are independent: renaming an account
 * must never recompute its username, because the username is what durable
 * references were written against -- recomputing it would break every one of
 * them, or worse, silently point them at whoever holds that name next.
 *
 * Runs of characters outside the alphabet collapse to a single dot rather than
 * vanishing, so "Ada Lovelace" and "AdaLovelace" do not derive the same
 * candidate. Leading and trailing dots are trimmed, because a handle that
 * begins or ends with a separator reads as a typo.
 *
 * The result can still collide with a username already taken, which is the
 * caller's to resolve -- uniqueness belongs to the store. It returns an empty
 * string when a display name holds nothing usable at all (all punctuation, or
 * emoji); there is no sensible handle to invent there, and inventing one is
 * worse than asking.
 */
export function usernameFromDisplayName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
}
