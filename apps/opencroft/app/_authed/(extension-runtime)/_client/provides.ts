'use client'

import { useEffect, useSyncExternalStore } from 'react'

/**
 * Generic extension provider points — the runtime's abstraction for features
 * (dashboards, panels, …) to collect declarations from extensions without the
 * runtime knowing what they mean. Extensions declare `provides: { <point>: [...] }`;
 * a feature reads `useProvided(point)`.
 */
export type ProvidesMap = Record<string, unknown[]>

const EMPTY: readonly unknown[] = []

class ProviderRegistry {
  private byExtension = new Map<string, ProvidesMap>()
  private listeners = new Set<() => void>()
  private byPoint = new Map<string, unknown[]>()

  register(extensionId: string, provides: ProvidesMap): void {
    this.byExtension.set(extensionId, provides)
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
    for (const provides of this.byExtension.values()) {
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

// ── One-time extension load, shared across every consumer ────────────────────

type LoadState = 'idle' | 'loading' | 'loaded'

let state: LoadState = 'idle'
let loadPromise: Promise<unknown> | null = null
const stateListeners = new Set<() => void>()

function setState(next: LoadState): void {
  state = next
  for (const listener of stateListeners) {
    listener()
  }
}

function ensureLoaded(loadExtensions: () => Promise<unknown>): void {
  if (loadPromise) {
    return
  }
  setState('loading')
  loadPromise = Promise.resolve(loadExtensions()).finally(() => setState('loaded'))
}

function subscribeState(listener: () => void): () => void {
  stateListeners.add(listener)
  return () => {
    stateListeners.delete(listener)
  }
}

function getState(): LoadState {
  return state
}

/**
 * Returns the items provided to `point` and whether the one-time extension load
 * finished. The load runs once per session; reloads flow through the registry
 * subscription (the host clears and re-registers on reload).
 */
export function useProvided<T>(point: string, loadExtensions: () => Promise<unknown>): { items: T[]; loaded: boolean } {
  const items = useSyncExternalStore(
    providerRegistry.subscribe,
    () => providerRegistry.get<T>(point),
    () => providerRegistry.get<T>(point),
  )
  const loadState = useSyncExternalStore(subscribeState, getState, getState)
  useEffect(() => {
    ensureLoaded(loadExtensions)
  }, [loadExtensions])
  return { items, loaded: loadState === 'loaded' }
}
