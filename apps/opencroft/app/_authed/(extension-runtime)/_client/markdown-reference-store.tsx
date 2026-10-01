import type { MarkdownReference, MarkdownResolver } from '@opencroft/client'
import {
  type InlineReference,
  installMarkdownReferences,
  type ReferenceRecogniser,
} from 'agent-chat/components/markdown-references'
import {
  REFERENCE_CHIP_CLASS,
  REFERENCE_CHIP_ICON_CLASS,
  REFERENCE_CHIP_UNKNOWN_CLASS,
  referenceChipToneClass,
} from 'agent-chat/components/reference-chip'
import { cn } from 'cn'
import type { ReactNode } from 'react'

import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'

/*
 * The extensions' markdown resolvers, turned into the one reference source
 * every markdown surface reads (`agent-chat/components/markdown-references`).
 *
 * What is on screen asks this store; the store asks each resolver once per
 * tick for everything it claimed that is not already known, and keeps the
 * answers. They are refreshed when the resolver says they changed, and only
 * a resolver with no way to say so is asked again, after a minute.
 */

/** A reference's mark as an element: a lucide name resolved, an owner's own mark as it is. */
export function referenceIcon(icon: MarkdownReference['icon']): ReactNode {
  if (typeof icon !== 'string') {
    return icon
  }
  const Icon = resolveIcon(icon)
  return <Icon />
}

/** How long an answer lasts from a resolver with no `subscribe`. */
const UNWATCHED_TTL_MS = 60_000
/** Answers kept per resolver; the oldest nobody is showing go first. */
const CACHE_LIMIT = 2000

export interface ReferenceEntry {
  status: 'resolved' | 'unknown'
  reference?: MarkdownReference
  at: number
}

const keyOf = (kind: string, id: string) => `${kind}\n${id}`

// A named group would collide with the ones the patterns are folded under, and
// an expression that does not compile would take every other resolver's with
// it -- so a pattern is checked before it joins.
function usablePattern(resolver: MarkdownResolver, pattern: RegExp | string | null): RegExp | string | null {
  if (pattern === null) {
    return null
  }
  const source = typeof pattern === 'string' ? pattern : pattern.source
  try {
    new RegExp(source)
  } catch (error) {
    console.error(`[markdown resolvers] ${resolver.id}: pattern does not compile`, error)
    return null
  }
  if (/\(\?<(?![=!])/.test(source)) {
    console.error(`[markdown resolvers] ${resolver.id}: named groups are not allowed in a pattern`)
    return null
  }
  return pattern
}

export class ReferenceStore {
  /** `render` draws a recognised reference in read-only markdown. */
  constructor(private readonly render: (reference: InlineReference) => ReactNode) {}

  private resolvers = new Map<string, MarkdownResolver>()
  private patterns = new Map<string, RegExp | string | null>()
  private teardown = new Map<string, Array<() => void>>()
  private entries = new Map<string, Map<string, ReferenceEntry>>()
  private listeners = new Map<string, Set<() => void>>()
  private anyListeners = new Set<() => void>()
  private queued = new Map<string, Set<string>>()
  private inflight = new Set<string>()
  /** In flight when their resolver said they changed: the answer on its way is already stale. */
  private staleInFlight = new Set<string>()
  private scheduled = false
  private notifyScheduled = false

  /** Counted for the performance measurement: calls to `resolve`, and identifiers across them. */
  readonly stats = { resolveCalls: 0, idsRequested: 0 }

  sync(list: MarkdownResolver[]): void {
    const next = new Map(list.map((resolver) => [resolver.id, resolver]))
    for (const [id, resolver] of this.resolvers) {
      if (next.get(id) !== resolver) {
        this.drop(id)
      }
    }
    for (const [id, resolver] of next) {
      if (this.resolvers.get(id) !== resolver) {
        this.add(resolver)
      }
    }
    this.install()
  }

  resolver(kind: string): MarkdownResolver | undefined {
    return this.resolvers.get(kind)
  }

  get(kind: string, id: string): ReferenceEntry | undefined {
    return this.entries.get(kind)?.get(id)
  }

  subscribe(kind: string, id: string, listener: () => void): () => void {
    const key = keyOf(kind, id)
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) {
        this.listeners.delete(key)
      }
    }
  }

  /** Ask for a reference; nothing happens if it is known and fresh, or already on its way. */
  request(kind: string, id: string): void {
    const resolver = this.resolvers.get(kind)
    const key = keyOf(kind, id)
    if (!resolver || this.inflight.has(key)) {
      return
    }
    const entry = this.get(kind, id)
    // `at: 0` is an answer its resolver said has changed.
    if (entry && entry.at > 0 && (resolver.subscribe || Date.now() - entry.at < UNWATCHED_TTL_MS)) {
      return
    }
    let ids = this.queued.get(kind)
    if (!ids) {
      ids = new Set()
      this.queued.set(kind, ids)
    }
    ids.add(id)
    if (!this.scheduled) {
      this.scheduled = true
      setTimeout(() => this.flush(), 0)
    }
  }

  private flush(): void {
    this.scheduled = false
    const batches = this.queued
    this.queued = new Map()
    for (const [kind, ids] of batches) {
      const resolver = this.resolvers.get(kind)
      if (!resolver) {
        continue
      }
      const list = [...ids]
      for (const id of list) {
        this.inflight.add(keyOf(kind, id))
      }
      this.stats.resolveCalls += 1
      this.stats.idsRequested += list.length
      Promise.resolve()
        .then(() => resolver.resolve(list))
        .then(
          (answers) => this.settle(kind, list, answers ?? {}),
          (error) => {
            // Not recorded as unknown: a failed lookup says nothing about the
            // identifier, so it stays as written and is asked again next time.
            console.error(`[markdown resolvers] ${kind}: resolve failed`, error)
            // Nothing was recorded, so the next request asks again anyway.
            this.release(kind, list)
          },
        )
    }
  }

  /** Ends the flight of `ids`, returning those invalidated while it lasted. */
  private release(kind: string, ids: string[]): string[] {
    const stale: string[] = []
    for (const id of ids) {
      const key = keyOf(kind, id)
      this.inflight.delete(key)
      if (this.staleInFlight.delete(key)) {
        stale.push(id)
      }
    }
    return stale
  }

  private settle(kind: string, ids: string[], answers: Record<string, MarkdownReference | null>): void {
    const stale = this.release(kind, ids)
    if (this.resolvers.get(kind) === undefined) {
      return
    }
    let cache = this.entries.get(kind)
    if (!cache) {
      cache = new Map()
      this.entries.set(kind, cache)
    }
    const at = Date.now()
    for (const id of ids) {
      const reference = Object.hasOwn(answers, id) ? answers[id] : null
      // Re-inserted, so the map's order is least recently answered first.
      cache.delete(id)
      cache.set(id, reference ? { status: 'resolved', reference, at } : { status: 'unknown', at })
      this.notify(keyOf(kind, id))
    }
    this.evict(kind, cache)
    this.notifyAny()
    // Shown now, but answered from before the change: asked again at once.
    if (stale.length) {
      this.invalidate(kind, stale)
    }
  }

  private evict(kind: string, cache: Map<string, ReferenceEntry>): void {
    for (const id of cache.keys()) {
      if (cache.size <= CACHE_LIMIT) {
        return
      }
      if (!this.listeners.has(keyOf(kind, id))) {
        cache.delete(id)
      }
    }
  }

  /** What a resolver said may have changed: shown references are asked again, the rest forgotten. */
  private invalidate(kind: string, ids?: string[]): void {
    // Whatever is on its way now left before the change.
    for (const key of this.inflight) {
      const [keyKind, id] = key.split('\n')
      if (keyKind === kind && (!ids || ids.includes(id))) {
        this.staleInFlight.add(key)
      }
    }
    const cache = this.entries.get(kind)
    if (!cache) {
      return
    }
    for (const id of ids ?? [...cache.keys()]) {
      const entry = cache.get(id)
      if (!entry) {
        continue
      }
      if (this.listeners.has(keyOf(kind, id))) {
        // Kept on screen, marked stale, while the new answer is on its way.
        cache.set(id, { ...entry, at: 0 })
        this.request(kind, id)
      } else {
        cache.delete(id)
      }
    }
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) {
      listener()
    }
  }

  // The editor re-decorates on this; once per batch of answers is enough.
  private notifyAny(): void {
    if (this.notifyScheduled) {
      return
    }
    this.notifyScheduled = true
    queueMicrotask(() => {
      this.notifyScheduled = false
      for (const listener of this.anyListeners) {
        listener()
      }
    })
  }

  private add(resolver: MarkdownResolver): void {
    this.resolvers.set(resolver.id, resolver)
    this.patterns.set(resolver.id, usablePattern(resolver, resolver.pattern))
    const teardown: Array<() => void> = []
    if (resolver.watchPattern) {
      teardown.push(
        resolver.watchPattern((pattern) => {
          if (this.resolvers.get(resolver.id) !== resolver) {
            return
          }
          this.patterns.set(resolver.id, usablePattern(resolver, pattern))
          this.install()
        }),
      )
    }
    if (resolver.subscribe) {
      teardown.push(resolver.subscribe((ids) => this.invalidate(resolver.id, ids)))
    }
    this.teardown.set(resolver.id, teardown)
  }

  private drop(id: string): void {
    for (const stop of this.teardown.get(id) ?? []) {
      stop()
    }
    this.teardown.delete(id)
    this.resolvers.delete(id)
    this.patterns.delete(id)
    this.entries.delete(id)
  }

  private recognisers(): ReferenceRecogniser[] {
    const recognisers: ReferenceRecogniser[] = []
    for (const [id, resolver] of this.resolvers) {
      const pattern = this.patterns.get(id)
      if (pattern !== null && pattern !== undefined) {
        recognisers.push({ kind: id, match: resolver.match ?? 'text', pattern })
      }
    }
    return recognisers
  }

  private install(): void {
    const recognisers = this.recognisers()
    installMarkdownReferences(
      recognisers.length === 0
        ? null
        : {
            recognisers,
            render: this.render,
            decorate: (reference) => this.decorate(reference),
            request: (references) => {
              for (const reference of references) {
                this.request(reference.kind, reference.id)
              }
            },
            subscribe: (listener) => {
              this.anyListeners.add(listener)
              return () => {
                this.anyListeners.delete(listener)
              }
            },
          },
    )
  }

  /** The chip as it looks in the editor: styling on the stored text, its mark before it. */
  private decorate({ kind, id }: InlineReference) {
    const entry = this.get(kind, id)
    const shown = this.shown(kind, id, entry)
    const icon = referenceIcon(shown.icon)
    return {
      className: cn(
        REFERENCE_CHIP_CLASS,
        entry?.status === 'unknown' && REFERENCE_CHIP_UNKNOWN_CLASS,
        shown.tone && entry?.status !== 'unknown' && referenceChipToneClass(shown.tone),
      ),
      // Sized as the chip sizes its mark: the editor's widget has no chip
      // around it to do that.
      icon: icon ? <span className={cn(REFERENCE_CHIP_ICON_CLASS, 'mr-1 align-[-0.125em]')}>{icon}</span> : undefined,
    }
  }

  /** What a chip shows: the answer, else the resolver's preview, else the identifier as written. */
  shown(kind: string, id: string, entry: ReferenceEntry | undefined): MarkdownReference {
    if (entry?.reference) {
      return entry.reference
    }
    const preview = this.resolvers.get(kind)?.preview?.(id)
    return { ...preview, label: preview?.label ?? id }
  }
}
