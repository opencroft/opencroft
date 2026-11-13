// The extension registries an administrator adds in Settings, beside the
// default registry and the ones OPENCROFT_EXTENSION_REGISTRIES names. Stored in
// one settings row; credentials are references to secrets, never values.
//
// Which secrets a registry may use: any key of any Secrets Store node on any
// graph of the instance. The setting is instance-wide and only an administrator
// writes it, so no space bounds it. A reference names its store and its key,
// because a name alone can be held by several stores.

import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import type { InstallAuth } from '@/app/_authed/(extension-runtime)/_server/extension-rows'
import { mutateSettingData, withSettingLock } from '@/app/_authed/(settings)/_server/settings-cas'
import { getSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { secrets } from '@/server/secrets'

export const REGISTRY_SETTING_ID = 'extension-registries'

/** One secret, by the Secrets Store node that holds it and its key there. */
export interface SecretRef {
  storeId: string
  key: string
}

/** A registry added in Settings. */
export interface StoredRegistry {
  id: string
  /** `owner/repo` (GitHub) or a full git URL, without credentials. */
  repository: string
  /** The sign-in name. Without it, `x-access-token`, as for a token. */
  username?: SecretRef
  /** The password or token. A registry without it is read without signing in. */
  password?: SecretRef
}

export type RegistryInput = Omit<StoredRegistry, 'id'> & { id?: string }

/** A key a registry's credential can be picked from, with where its store is. */
export interface SecretChoice extends SecretRef {
  /** `<space> / <graph> / <store>`: the store as a reader finds it. */
  store: string
}

function readRef(value: unknown): SecretRef | undefined {
  const ref = value as Partial<SecretRef> | null | undefined
  return typeof ref?.storeId === 'string' && ref.storeId && typeof ref.key === 'string' && ref.key
    ? { storeId: ref.storeId, key: ref.key }
    : undefined
}

/** The rows of the stored list that are well formed; anything else in it is skipped. */
export function readStoredRegistries(data: Record<string, unknown>): StoredRegistry[] {
  const list = Array.isArray(data.registries) ? data.registries : []
  const registries: StoredRegistry[] = []
  for (const item of list as Partial<StoredRegistry>[]) {
    if (typeof item?.id !== 'string' || typeof item.repository !== 'string' || !item.repository.trim()) {
      continue
    }
    const username = readRef(item.username)
    const password = readRef(item.password)
    registries.push({
      id: item.id,
      repository: item.repository,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    })
  }
  return registries
}

export async function listStoredRegistries(): Promise<StoredRegistry[]> {
  return readStoredRegistries((await getSettingImpl(REGISTRY_SETTING_ID))?.data ?? {})
}

/**
 * The credential a stored registry signs in with, in the form an install
 * records, so an extension installed from the registry signs in the same way.
 * An install names one store, which is why both keys come from one store.
 */
export function storedRegistryAuth(registry: StoredRegistry): InstallAuth | undefined {
  if (!registry.password) {
    return undefined
  }
  return {
    type: 'secret',
    storeId: registry.password.storeId,
    tokenKey: registry.password.key,
    ...(registry.username ? { usernameKey: registry.username.key } : {}),
  }
}

/**
 * Why `repository` can't be stored, or undefined. A URL that carries a
 * credential is refused: the setting holds references, and a typed credential
 * would be readable by every reader of the setting.
 */
export function repositoryProblem(repository: string): string | undefined {
  if (!repository) {
    return 'Give the repository: owner/repo or a git URL.'
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    return undefined
  }
  let url: URL
  try {
    url = new URL(repository)
  } catch {
    return 'The repository is neither owner/repo nor a URL.'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'The repository URL must start with https:// or http://.'
  }
  if (url.username || url.password) {
    return 'Take the credentials out of the URL and pick them from a Secrets Store.'
  }
  return undefined
}

/**
 * Every key of every Secrets Store node on the instance, sorted by where the
 * store is. Names only: nothing here decrypts.
 */
export async function listSecretChoices(): Promise<SecretChoice[]> {
  const spaces = getSpacesRegistry()
  await spaces.ensureLoaded()
  const choices: SecretChoice[] = []
  for (const ref of spaces.listGraphs()) {
    for (const node of ref.graph.graph.nodes as { id?: unknown; type?: unknown; data?: { name?: unknown } }[]) {
      if (typeof node.id !== 'string' || parseType(String(node.type ?? ''))?.bare !== 'core-secrets-store') {
        continue
      }
      const name = typeof node.data?.name === 'string' && node.data.name.trim() ? node.data.name : 'Secrets Store'
      const store = `${ref.space.name} / ${ref.graph.name} / ${name}`
      for (const key of await secrets.listKeys(node.id)) {
        choices.push({ storeId: node.id, key, store })
      }
    }
  }
  return choices.sort((a, b) => a.store.localeCompare(b.store) || a.key.localeCompare(b.key))
}

/** Why the credential picks can't be stored, or undefined. */
export async function credentialProblem(input: RegistryInput): Promise<string | undefined> {
  const { username, password } = input
  if (username && !password) {
    return 'Pick the password or token too: a username alone signs nobody in.'
  }
  if (username && password && username.storeId !== password.storeId) {
    return 'Pick the username and the password from the same Secrets Store: an extension installed from this registry signs in with them, and an install names one store.'
  }
  const choices = await listSecretChoices()
  for (const [what, ref] of [
    ['username', username],
    ['password', password],
  ] as const) {
    if (ref && !choices.some((choice) => choice.storeId === ref.storeId && choice.key === ref.key)) {
      return `The ${what} secret ${ref.key} is not in a Secrets Store on this instance.`
    }
  }
  return undefined
}

/**
 * Add a registry (no `id`) or replace the one with `id`, refusing an `id` that
 * is not stored. Returns the stored registry.
 */
export async function saveStoredRegistry(input: RegistryInput): Promise<StoredRegistry> {
  const registry: StoredRegistry = { ...input, id: input.id ?? crypto.randomUUID() }
  await withSettingLock(REGISTRY_SETTING_ID, () =>
    mutateSettingData(REGISTRY_SETTING_ID, (data) => {
      const list = readStoredRegistries(data)
      if (!input.id) {
        return { ...data, registries: [...list, registry] }
      }
      if (!list.some((item) => item.id === input.id)) {
        throw new Error('That registry is not in Settings any more.')
      }
      return { ...data, registries: list.map((item) => (item.id === input.id ? registry : item)) }
    }),
  )
  return registry
}

/** Remove the registry with `id`. Whether there was one. */
export async function removeStoredRegistry(id: string): Promise<boolean> {
  let removed = false
  await withSettingLock(REGISTRY_SETTING_ID, () =>
    mutateSettingData(REGISTRY_SETTING_ID, (data) => {
      const list = readStoredRegistries(data)
      const next = list.filter((item) => item.id !== id)
      removed = next.length < list.length
      return removed ? { ...data, registries: next } : data
    }),
  )
  return removed
}
