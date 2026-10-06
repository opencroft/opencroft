import type { ExtensionUpdate } from 'ui/extensions/extension-updates'

import type { UpdateOutcome } from '@/app/_authed/(extension-editor)/_components/update-overview'

// Taking updates, apart from what takes them: the order of the steps, what is
// recorded on each row, and the rule that nothing after an update can stop the
// run or leave a row waiting. The page's hook supplies the steps.

/** What taking one update came to, in the sentence the page shows. */
export interface UpdateResult {
  ok: boolean
  /** Whether the extension moved. A pull that found nothing new is ok and did not. */
  changed: boolean
  message: string
}

/** How an Update all went. Skipped are the extensions listed as unable to update. */
export interface UpdateAllSummary {
  updated: number
  /** Taken, and found to be up to date already. */
  current: number
  failed: number
  skipped: number
}

export interface UpdateSteps {
  /** Take the update. */
  take: (folder: string) => Promise<UpdateResult>
  /** Read back what the update changed. */
  reread: (folder: string) => Promise<void>
  /** Put a row's outcome on screen, or take it off with null. */
  record: (folder: string, outcome: UpdateOutcome | null) => void
}

export interface RunSteps extends UpdateSteps {
  progress: (progress: { done: number; total: number } | undefined) => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Take one update and read back what it changed, without ever rejecting. The
 * update is reported as it went: a read-back that fails afterwards is added to
 * its message, and does not turn an update that landed into a failure.
 * `taken` is told once the update's own outcome is on its row, before the
 * read-back.
 */
export async function takeOne(
  folder: string,
  span: { from: string; to: string } | null,
  steps: UpdateSteps,
  taken?: () => void,
): Promise<UpdateResult> {
  if (span) {
    steps.record(folder, { state: 'updating', ...span })
  }
  let result: UpdateResult
  try {
    result = await steps.take(folder)
  } catch (err) {
    result = { ok: false, changed: false, message: errorMessage(err) }
  }
  if (span) {
    steps.record(folder, { state: result.ok ? 'updated' : 'failed', message: result.message, ...span })
  }
  taken?.()
  try {
    await steps.reread(folder)
  } catch (err) {
    result = { ...result, message: `${result.message}. Reading it back failed, reload the page: ${errorMessage(err)}` }
    if (span) {
      steps.record(folder, { state: result.ok ? 'updated' : 'failed', message: result.message, ...span })
    }
  }
  return result
}

/**
 * Take updates one at a time: each installs and builds, and the instance
 * reloads what it runs after each. A failure is recorded on its row and the run
 * goes on. Progress counts an update as done once its outcome is on its row. If
 * a step throws, the rows the run never reached go back to what their check
 * said.
 */
export async function runUpdates(
  queue: ExtensionUpdate[],
  steps: RunSteps,
): Promise<Omit<UpdateAllSummary, 'skipped'>> {
  const tally = { updated: 0, current: 0, failed: 0 }
  const waiting = new Set(queue.map((item) => item.id))
  for (const item of queue) {
    steps.record(item.id, { state: 'queued', from: item.from, to: item.to })
  }
  let done = 0
  steps.progress({ done, total: queue.length })
  try {
    for (const item of queue) {
      waiting.delete(item.id)
      const result = await takeOne(item.id, { from: item.from, to: item.to }, steps, () => {
        done += 1
        steps.progress({ done, total: queue.length })
      })
      if (!result.ok) {
        tally.failed += 1
      } else if (result.changed) {
        tally.updated += 1
      } else {
        tally.current += 1
      }
    }
  } finally {
    for (const id of waiting) {
      steps.record(id, null)
    }
    steps.progress(undefined)
  }
  return tally
}
