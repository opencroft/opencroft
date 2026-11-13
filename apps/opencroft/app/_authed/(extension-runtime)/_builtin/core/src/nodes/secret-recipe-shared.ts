// The bounds of a random Secrets Store value, which the store enforces and the
// inspector's dialogs check before asking. Host-free, for both sides.

import type { RandomSecretSpec, SecretFormat, SecretRecipe } from '@opencroft/server/secrets'

export const MIN_LENGTH = 8
export const MAX_LENGTH = 256

/** What `generate` makes when given no options, and what Rotate repeats for a secret stored without a recipe. */
export const DEFAULT_RANDOM: RandomSecretSpec = { length: 32, format: 'alphanumeric' }

/** Each format as a person picks it. */
export const FORMAT_LABELS: Record<SecretFormat, string> = {
  alphanumeric: 'Alphanumeric',
  symbols: 'With symbols',
  base64url: 'Base64url',
  hex: 'Hex',
  password: 'Readable password',
}

/** What the Random value dialog does with a secret. `create` makes a new one. On a stored one, `rotate`
 *  remakes a value the store can make again (a random or Bearer one), and `replace` gives anything
 *  else, a typed value or a password, a random one in its place. */
export type RandomValueMode = 'create' | 'rotate' | 'replace'

/** The mode for a row: unsaved, or stored and rotatable or not as the store reports it. */
export function randomValueMode(row: { savedKey?: string; rotatable?: boolean }): RandomValueMode {
  if (row.savedKey === undefined) {
    return 'create'
  }
  return row.rotatable === true ? 'rotate' : 'replace'
}

/** What the Random value dialog starts with for a secret: its recipe's length, format and prefix,
 *  so that Rotate pressed as it opens repeats the recipe; the defaults for anything else. */
export function startingRandom(recipe: SecretRecipe | null | undefined): { spec: RandomSecretSpec; bearer: boolean } {
  if (recipe?.kind === 'random') {
    return { spec: { length: recipe.length, format: recipe.format }, bearer: false }
  }
  if (recipe?.kind === 'bearer') {
    return { spec: recipe.token, bearer: true }
  }
  return { spec: DEFAULT_RANDOM, bearer: false }
}

/** What the Set password dialog starts with for a secret: the stored login with the Basic box as it
 *  was made, or an empty login with the box ticked. */
export function startingPassword(recipe: SecretRecipe | null | undefined): { login: string; basic: boolean } {
  if (recipe?.kind === 'basic' || recipe?.kind === 'login') {
    return { login: recipe.login, basic: recipe.kind === 'basic' }
  }
  return { login: '', basic: true }
}
