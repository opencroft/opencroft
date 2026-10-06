'use client'

import { useSyncExternalStore } from 'react'

import type { UpdateOutcome } from '@/app/_authed/(extension-editor)/_components/update-overview'
import type { RunSteps } from '@/app/_authed/(extension-editor)/_components/update-run'

export interface UpdateRunSnapshot {
  /** What each update taken on this tab came to, by folder. */
  outcomes: Readonly<Record<string, UpdateOutcome>>
  progress: { done: number; total: number } | undefined
}

const EMPTY: UpdateRunSnapshot = { outcomes: {}, progress: undefined }

function inFlight(outcomes: UpdateRunSnapshot['outcomes']): boolean {
  return Object.values(outcomes).some((outcome) => outcome.state === 'queued' || outcome.state === 'updating')
}

/**
 * The updates taken on this tab, kept apart from the page that shows them. An
 * update reinstalls code and the page re-reads after it, so the page can be
 * unmounted and mounted again in the middle of a run. The run belongs to the
 * tab, not to the page: it goes on, and the page mounted next shows its rows
 * and progress and does its read-backs.
 */
export class UpdateRunStore implements Omit<RunSteps, 'take'> {
  private snapshot: UpdateRunSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private reader: ((folder: string) => Promise<void>) | null = null

  private publish(next: UpdateRunSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) {
      listener()
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): UpdateRunSnapshot => this.snapshot

  readonly record = (folder: string, outcome: UpdateOutcome | null): void => {
    const { [folder]: _, ...rest } = this.snapshot.outcomes
    this.publish({ ...this.snapshot, outcomes: outcome ? { ...rest, [folder]: outcome } : rest })
  }

  readonly progress = (progress: UpdateRunSnapshot['progress']): void => {
    this.publish({ ...this.snapshot, progress })
  }

  /** Clear the outcomes of updates that have finished. While one is still under way nothing is cleared. */
  readonly clearOutcomes = (): void => {
    if (!inFlight(this.snapshot.outcomes)) {
      this.publish({ ...this.snapshot, outcomes: {} })
    }
  }

  /**
   * Make `read` the read-back of the mounted page. Returns the detach the page
   * calls when it unmounts, which only detaches `read` if it is still the
   * current one.
   */
  readonly attachReader = (read: (folder: string) => Promise<void>): (() => void) => {
    this.reader = read
    return () => {
      if (this.reader === read) {
        this.reader = null
      }
    }
  }

  /** Read back what an update changed, on the page mounted now. With none mounted there is nothing on screen to bring up to date. */
  readonly reread = async (folder: string): Promise<void> => {
    await this.reader?.(folder)
  }
}

/** This tab's updates. */
export const updateRuns = new UpdateRunStore()

export function useUpdateRuns(): UpdateRunSnapshot {
  return useSyncExternalStore(updateRuns.subscribe, updateRuns.getSnapshot, () => EMPTY)
}
