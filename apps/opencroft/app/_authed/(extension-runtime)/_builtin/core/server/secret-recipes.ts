import type { RandomSecretSpec, SecretFormat, SecretRecipe } from '@opencroft/server/secrets'

import { DEFAULT_RANDOM, MAX_LENGTH, MIN_LENGTH } from '../src/nodes/secret-recipe-shared'

// ═══════════════════════════════════════════════════════════════════
// Secret recipes
//
// How a Secrets Store value is made, and how Rotate makes the next one the
// same way. Host-free, so the plain test runner loads it; the caller passes
// the random source in.
// ═══════════════════════════════════════════════════════════════════

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// Each alphabet keeps to characters that need no escaping in a shell, a URL or
// an env line, since the value's only sanctioned path out is subprocess env
// injection.
const CHARSETS: Record<SecretFormat, string> = {
  hex: '0123456789abcdef',
  base64url: `${ALPHANUMERIC}-_`,
  // Letters and digits a person can read back without confusing them: no 0/O, 1/l/I.
  password: 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789',
  alphanumeric: ALPHANUMERIC,
  // A conservative symbol set: no quotes, backticks, `$` or other shell/URL metacharacters.
  symbols: `${ALPHANUMERIC}!@#%^&*_+-=`,
}

/** Draws `length` characters from `charset`. */
export type RandomString = (length: number, charset: string) => string

/** A value to store and how it was made. */
export interface MadeSecret {
  value: string
  recipe: SecretRecipe
}

/** The options a person or an agent asks for, checked and with the defaults filled in. */
export function randomSpec(options?: { length?: number; format?: SecretFormat }): RandomSecretSpec {
  const length = options?.length ?? DEFAULT_RANDOM.length
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    throw new Error(`length must be an integer between ${MIN_LENGTH} and ${MAX_LENGTH}`)
  }
  const format = options?.format ?? DEFAULT_RANDOM.format
  if (!Object.hasOwn(CHARSETS, format)) {
    throw new Error(`format must be one of ${Object.keys(CHARSETS).join(', ')}`)
  }
  return { length, format }
}

/** A random value as it is asked for: its length and format, and whether it goes under the
 *  `Bearer ` prefix. */
export interface RandomChoice {
  spec: RandomSecretSpec
  bearer: boolean
}

/** A random value's options as a caller sends them, checked; anything but `bearer: true` leaves
 *  the prefix off. */
export function randomChoice(options?: { length?: number; format?: SecretFormat; bearer?: unknown }): RandomChoice {
  return { spec: randomSpec(options), bearer: options?.bearer === true }
}

export function makeRandom({ spec, bearer }: RandomChoice, random: RandomString): MadeSecret {
  const drawn = random(spec.length, CHARSETS[spec.format])
  return bearer
    ? { value: `Bearer ${drawn}`, recipe: { kind: 'bearer', token: spec } }
    : { value: drawn, recipe: { kind: 'random', ...spec } }
}

export function makeTyped(value: string): MadeSecret {
  return { value, recipe: { kind: 'typed' } }
}

/** `login:password` as it is, or, with `basic`, as the HTTP Basic `Authorization` header value
 *  `Basic base64(login:password)`. The recipe keeps the login, never the password. */
export function makeLoginPassword(login: unknown, password: unknown, basic: boolean): MadeSecret {
  // RFC 7617 and `curl -u` alike end the login at the first colon.
  if (typeof login !== 'string' || !login || login.includes(':')) {
    throw new Error('A login is required and cannot contain ":"')
  }
  if (typeof password !== 'string' || !password) {
    throw new Error('A password is required')
  }
  const pair = `${login}:${password}`
  return basic
    ? { value: `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`, recipe: { kind: 'basic', login } }
    : { value: pair, recipe: { kind: 'login', login } }
}

/** The length and format Rotate draws with, or undefined for a value someone brought (typed, or a
 *  login and password), which only they can replace. A secret stored without a recipe is treated as random with the defaults. */
function rotationSpec(recipe: SecretRecipe | null): RandomSecretSpec | undefined {
  if (recipe === null) {
    return DEFAULT_RANDOM
  }
  if (recipe.kind === 'random') {
    return { length: recipe.length, format: recipe.format }
  }
  if (recipe.kind === 'bearer') {
    return recipe.token
  }
  return undefined
}

/** Whether Rotate can make the next value: only a value made here, by a recipe it can repeat. */
export function canRotate(recipe: SecretRecipe | null): boolean {
  return rotationSpec(recipe) !== undefined
}

/** The next value of a secret Rotate is offered for: made by `choice`, which becomes its recipe, or
 *  left out, by the stored recipe with the same length, format and prefix. */
export function remake(recipe: SecretRecipe | null, random: RandomString, choice?: RandomChoice): MadeSecret {
  const spec = rotationSpec(recipe)
  if (spec === undefined) {
    throw new Error('This value was brought from elsewhere, so it is not rotated here: set a new value instead')
  }
  return makeRandom(choice ?? { spec, bearer: recipe?.kind === 'bearer' }, random)
}
