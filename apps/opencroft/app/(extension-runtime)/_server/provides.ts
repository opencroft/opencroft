import { loadAllManifests } from '@/app/(extension-runtime)/_server/loader'

export interface Provided<T> {
  extensionId: string
  value: T
}

/**
 * Reads every extension's static `provides[point]` from its manifest, so the
 * server can enumerate a feature's entries before any client bundle loads.
 * Generic — the runtime never interprets the provided shape.
 */
export async function getProvided<T>(point: string): Promise<Provided<T>[]> {
  const manifests = await loadAllManifests()
  const result: Provided<T>[] = []
  for (const manifest of manifests) {
    const items = (manifest.provides?.[point] ?? []) as T[]
    for (const value of items) {
      result.push({ extensionId: manifest.id, value })
    }
  }
  return result
}
