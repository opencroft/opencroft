'use client'

import { useEffect, useSyncExternalStore } from 'react'

/**
 * Generic extension provider points — the runtime's abstraction for features
 * (apps, panels, …) to collect declarations from extensions without the
 * runtime knowing what they mean. Extensions declare `provides: { <point>: [...] }`;
 * a feature reads `useProvided(point)`.
 */
export type ProvidesMap = Record<string, unknown[]>

const EMPTY: readonly unknown[] = []

class ProviderRegistry {
  private byExtension = new Map<string, ProvidesMap>()
  private listeners = new Set<() => void>()
  private byPoint = new Map<string, unknown[]>()
  private rank = new Map<string, number>()

  register(extensionId: string, provides: ProvidesMap): void {
    this.byExtension.set(extensionId, provides)
    this.recompute()
  }

  /**
   * The order extensions' entries are listed in. Extensions load as the points
   * they provide are used, in no fixed order, so the order is the server's
   * listing rather than the order they happened to arrive in. An extension
   * the listing does not name follows, in the order it registered.
   */
  setOrder(extensionIds: string[]): void {
    this.rank = new Map(extensionIds.map((id, index) => [id, index]))
    this.recompute()
  }

  clear(): void {
    this.byExtension.clear()
    this.recompute()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get = <T>(point: string): T[] => (this.byPoint.get(point) ?? (EMPTY as T[])) as T[]

  private recompute(): void {
    const next = new Map<string, unknown[]>()
    const rankOf = (extensionId: string) => this.rank.get(extensionId) ?? Number.MAX_SAFE_INTEGER
    const ordered = [...this.byExtension].sort(([a], [b]) => rankOf(a) - rankOf(b))
    for (const [, provides] of ordered) {
      for (const [point, items] of Object.entries(provides)) {
        const list = next.get(point) ?? []
        list.push(...items)
        next.set(point, list)
      }
    }
    this.byPoint = next
    for (const listener of this.listeners) {
      listener()
    }
  }
}

export const providerRegistry = new ProviderRegistry()

// ── Loading a point's providers, once per point, shared by every consumer ─────

const startedPoints = new Set<string>()
const loadedPoints = new Set<string>()
const stateListeners = new Set<() => void>()

function ensureLoaded(point: string, loadProviders: (point: string) => Promise<unknown>): void {
  if (startedPoints.has(point)) {
    return
  }
  startedPoints.add(point)
  Promise.resolve(loadProviders(point)).finally(() => {
    loadedPoints.add(point)
    for (const listener of stateListeners) {
      listener()
    }
  })
}

function subscribeState(listener: () => void): () => void {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

/**
 * Returns the items provided to `point`, and whether the extensions that
 * provide it have loaded. `loadProviders(point)` loads them, once per point per
 * session, when the first consumer of the point mounts; reloads flow through
 * the registry subscription (the host clears and re-registers on reload).
 */
export function useProvided<T>(
  point: string,
  loadProviders: (point: string) => Promise<unknown>,
): { items: T[]; loaded: boolean } {
  const items = useSyncExternalStore(
    providerRegistry.subscribe,
    () => providerRegistry.get<T>(point),
    () => providerRegistry.get<T>(point),
  )
  const isLoaded = () => loadedPoints.has(point)
  const loaded = useSyncExternalStore(subscribeState, isLoaded, isLoaded)
  useEffect(() => {
    ensureLoaded(point, loadProviders)
  }, [point, loadProviders])
  return { items, loaded }
}
