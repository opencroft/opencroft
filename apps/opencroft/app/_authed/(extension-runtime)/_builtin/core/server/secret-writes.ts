import type { SecretRecipe } from '@opencroft/server/secrets'

import { type MadeSecret, type RandomChoice, type RandomString, remake } from './secret-recipes'

// ═══════════════════════════════════════════════════════════════════
// Secret writes
//
// The name rules for writing a value into a Secrets Store. Host-free, so the
// plain test runner loads it; callers pass the store operations in.
//
// A NEW name is trimmed and must not be blank. An EXISTING name is acted on
// exactly as stored: a key saved with spaces around it is still that key, and
// rotating it must replace its value rather than create a trimmed sibling.
// ═══════════════════════════════════════════════════════════════════

/** The name a new secret is stored under: trimmed, and never blank. */
export function requireSecretName(name: string): string {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) {
    throw new Error('Secret name is required')
  }
  return trimmed
}

/** Stores a value under the trimmed name; a blank name is refused before anything is written. */
export async function setSecretChecked(
  name: string,
  made: MadeSecret,
  set: (key: string, made: MadeSecret) => Promise<void>,
): Promise<void> {
  await set(requireSecretName(name), made)
}

export interface SecretRotateStore {
  /** The stored recipe of each key the store holds; null for a key stored without one. */
  listRecipes(): Promise<Map<string, SecretRecipe | null>>
  /** Writes `made` under `key`, verbatim. */
  write(key: string, made: MadeSecret): Promise<void>
}

/** Replaces the value of a secret the store holds, under its exact stored
 *  key, with the next one its recipe makes. A name the store does not hold is
 *  refused rather than created: rotating is only ever asked of a row that was
 *  there. A value someone brought is refused too. `choice` is as for `remake`. */
export async function rotateSecretChecked(
  name: string,
  store: SecretRotateStore,
  random: RandomString,
  choice?: RandomChoice,
): Promise<{ name: string; status: 'rotated' }> {
  const recipes = await store.listRecipes()
  if (!recipes.has(name)) {
    throw new Error(`Secret "${name}" is not in this store`)
  }
  await store.write(name, remake(recipes.get(name) ?? null, random, choice))
  return { name, status: 'rotated' }
}
