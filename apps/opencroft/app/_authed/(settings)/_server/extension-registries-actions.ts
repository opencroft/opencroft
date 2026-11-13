import { createServerFn } from '@tanstack/react-start'

import {
  checkRegistry,
  clearRegistryCache,
  loadRegistries,
  type RegistryOrigin,
  storedRegistryProblem,
} from '@/app/_authed/(extension-runtime)/_server/registry'
import {
  listSecretChoices,
  listStoredRegistries,
  type RegistryInput,
  removeStoredRegistry,
  type SecretChoice,
  type SecretRef,
  saveStoredRegistry,
} from '@/app/_authed/(extension-runtime)/_server/registry-settings'
import { adminOnly } from '@/app/_authed/(settings)/_server/admin-middleware'

// The Extension registries page. Every endpoint is an administrator's: the
// registries are instance configuration, and their credential picks name
// Secrets Stores anywhere on the instance. No answer carries a secret's value:
// credentials travel as store and key, and an environment registry's inline
// credential only as "it has one".

/** One registry as the page lists it. */
export interface ExtensionRegistryRow {
  origin: RegistryOrigin
  /** For one added in Settings: what edit and remove address. */
  id?: string
  repository: string
  needsCredentials: boolean
  /** The picks of one added in Settings. */
  username?: SecretRef
  password?: SecretRef
  /** How many extensions it lists, when it could be read. */
  extensions?: number
  /** Why the latest read failed. */
  error?: string
}

function readRef(value: unknown, what: string): SecretRef | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  const ref = value as Partial<SecretRef>
  if (typeof ref.storeId !== 'string' || !ref.storeId || typeof ref.key !== 'string' || !ref.key) {
    throw new Error(`Expected the ${what} as { storeId, key }`)
  }
  return { storeId: ref.storeId, key: ref.key }
}

function registryInput(input: RegistryInput): RegistryInput {
  const { id, repository, username, password } = (input ?? {}) as Partial<RegistryInput>
  if (typeof repository !== 'string' || (id !== undefined && typeof id !== 'string')) {
    throw new Error('Expected { id?, repository, username?, password? }')
  }
  const user = readRef(username, 'username')
  const pass = readRef(password, 'password')
  return {
    ...(id ? { id } : {}),
    repository: repository.trim(),
    ...(user ? { username: user } : {}),
    ...(pass ? { password: pass } : {}),
  }
}

export const listExtensionRegistries = createServerFn({ strict: { output: false } })
  .middleware([adminOnly])
  .handler(async (): Promise<ExtensionRegistryRow[]> => {
    const [outcomes, stored] = await Promise.all([loadRegistries(), listStoredRegistries()])
    const picksOf = (item: (typeof stored)[number]) => ({
      origin: 'settings' as const,
      id: item.id,
      repository: item.repository,
      needsCredentials: Boolean(item.password),
      ...(item.username ? { username: item.username } : {}),
      ...(item.password ? { password: item.password } : {}),
    })
    const rows: ExtensionRegistryRow[] = outcomes.map(({ source, registry, error }) => {
      const item = source.origin === 'settings' ? stored.find((s) => s.id === source.id) : undefined
      return {
        ...(item
          ? picksOf(item)
          : { origin: source.origin, repository: source.url, needsCredentials: Boolean(source.token || source.auth) }),
        ...(registry ? { extensions: registry.manifest.extensions.length } : {}),
        ...(error ? { error } : {}),
      }
    })
    // A stored registry the environment came to name too is read from there,
    // and is still listed here so it can be removed.
    for (const item of stored) {
      if (!rows.some((row) => row.id === item.id)) {
        rows.push({ ...picksOf(item), error: 'Not read: the same registry is listed above.' })
      }
    }
    return rows
  })

export const listRegistrySecretChoices = createServerFn({ strict: { output: false } })
  .middleware([adminOnly])
  .handler(async (): Promise<SecretChoice[]> => listSecretChoices())

export const checkExtensionRegistry = createServerFn({ method: 'POST', strict: { output: false } })
  .middleware([adminOnly])
  .inputValidator(registryInput)
  .handler(async ({ data }): Promise<{ extensions: number } | { error: string }> => checkRegistry(data))

// Saving and removing empty the registry cache, so the next search, install
// or agent's registry_list reads the registries as they are now.
export const saveExtensionRegistry = createServerFn({ method: 'POST', strict: { output: false } })
  .middleware([adminOnly])
  .inputValidator(registryInput)
  .handler(async ({ data }): Promise<void> => {
    const problem = await storedRegistryProblem(data)
    if (problem) {
      throw new Error(problem)
    }
    await saveStoredRegistry(data)
    clearRegistryCache()
  })

export const removeExtensionRegistry = createServerFn({ method: 'POST', strict: { output: false } })
  .middleware([adminOnly])
  .inputValidator((id: string) => {
    if (typeof id !== 'string' || !id) {
      throw new Error('Expected the registry id')
    }
    return id
  })
  .handler(async ({ data: id }): Promise<void> => {
    if (!(await removeStoredRegistry(id))) {
      throw new Error('That registry is not in Settings: the default and the environment registries stay.')
    }
    clearRegistryCache()
  })
