'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ExtensionIndexEntry } from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import {
  checkInstalledForUpdates,
  type UpdateCheck,
  type UpdateCheckFailure,
  updateInstalledExtension,
} from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import {
  checkLocalExtensionRemote,
  type LocalRemoteState,
  pullLocalExtension,
} from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'
import {
  refLabel,
  shortCommit,
  takeableUpdates,
  type UpdateFindings,
  updateFinding,
  updateOverview,
} from '@/app/_authed/(extension-editor)/_components/update-overview'
import {
  runUpdates,
  takeOne,
  type UpdateAllSummary,
  type UpdateResult,
  type UpdateSteps,
} from '@/app/_authed/(extension-editor)/_components/update-run'
import { updateRuns, useUpdateRuns } from '@/app/_authed/(extension-editor)/_components/update-run-store'
import { isLocalFolder } from '@/app/_authed/(extension-runtime)/_extension-id'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Whether there is a source to ask about this extension: its folder is there, and an installed one recorded where it came from. */
function checkable(entry: ExtensionIndexEntry): boolean {
  return !entry.missing && (entry.kind === 'local' || entry.sourceUrl !== undefined)
}

// Two different acts under one name, because they are the same intention: an
// installed extension is reinstalled at what its check offered, and a local
// checkout is fast-forwarded to its branch on origin and rebuilt.
async function takeUpdate(folder: string, check: UpdateCheck | undefined): Promise<UpdateResult> {
  try {
    if (!isLocalFolder(folder)) {
      const record = await updateInstalledExtension({ data: { folder, ref: check?.latest ?? undefined } })
      const ref = record.source?.ref ?? null
      const label = refLabel(ref, record.source?.commit ?? null, check?.followsBranch ?? false)
      return { ok: true, changed: true, message: ref ? `Updated to ${label}` : 'Updated to its newest version' }
    }
    const result = await pullLocalExtension({ data: folder })
    if (!result.moved) {
      return { ok: true, changed: false, message: 'Already up to date' }
    }
    if (result.build.success) {
      return { ok: true, changed: true, message: `Updated to ${shortCommit(result.to)} and rebuilt` }
    }
    // The files moved and the build did not: saying "update failed" would
    // describe a checkout that did update.
    return {
      ok: false,
      changed: true,
      message: `Updated to ${shortCommit(result.to)}, but the rebuild failed: ${result.build.errors[0]?.message ?? 'see the editor'}`,
    }
  } catch (err) {
    return { ok: false, changed: false, message: errorMessage(err) }
  }
}

/**
 * Where every extension on the page stands against its source, and taking the
 * updates that has to offer. Checked once when the page opens — one round trip
 * per extension, all at once, never holding the list back — and again on
 * request. `afterUpdate` runs once an update has landed or failed, for the page
 * to re-read what changed.
 */
export function useExtensionUpdates(entries: ExtensionIndexEntry[], afterUpdate: (folder: string) => Promise<void>) {
  const [installed, setInstalled] = useState<Record<string, UpdateCheck>>({})
  const [installedErrors, setInstalledErrors] = useState<Record<string, UpdateCheckFailure>>({})
  const [local, setLocal] = useState<Record<string, LocalRemoteState>>({})
  const [checkingFolders, setCheckingFolders] = useState<ReadonlySet<string>>(new Set())
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const { outcomes, progress } = useUpdateRuns()

  const findings: UpdateFindings = useMemo(
    () => ({ installed, installedErrors, local }),
    [installed, installedErrors, local],
  )
  const overview = useMemo(() => updateOverview(entries, findings, outcomes), [entries, findings, outcomes])
  const running = overview.updates.some((update) => update.state === 'queued' || update.state === 'updating')

  // Acts read the state as it is when they run, not as it was when their
  // callback was made: an Update all outlives many renders.
  const latest = useRef({ entries, findings, outcomes, overview, afterUpdate })
  latest.current = { entries, findings, outcomes, overview, afterUpdate }

  const checkFolder = useCallback(async (folder: string) => {
    setCheckingFolders((prev) => new Set(prev).add(folder))
    try {
      if (isLocalFolder(folder)) {
        let state: LocalRemoteState
        try {
          state = await checkLocalExtensionRemote({ data: folder })
        } catch (err) {
          state = {
            branch: null,
            localCommit: null,
            remoteCommit: null,
            behind: false,
            blocked: null,
            error: errorMessage(err),
            errorDetail: null,
          }
        }
        setLocal((prev) => ({ ...prev, [folder]: state }))
        return
      }
      let check: UpdateCheck | UpdateCheckFailure
      try {
        check = await checkInstalledForUpdates({ data: folder })
      } catch (err) {
        check = { error: errorMessage(err), detail: null }
      }
      if ('error' in check) {
        const failure = check
        setInstalledErrors((prev) => ({ ...prev, [folder]: failure }))
      } else {
        const found = check
        setInstalled((prev) => ({ ...prev, [folder]: found }))
        setInstalledErrors(({ [folder]: _, ...rest }) => rest)
      }
    } finally {
      setCheckingFolders((prev) => {
        const next = new Set(prev)
        next.delete(folder)
        return next
      })
    }
  }, [])

  const checkAll = useCallback(async () => {
    // A fresh look at everything clears the outcomes of the last run: they
    // described the state this check replaces. A run still under way keeps
    // its rows.
    updateRuns.clearOutcomes()
    await Promise.all(latest.current.entries.filter(checkable).map((entry) => checkFolder(entry.folder)))
    setCheckedAt(Date.now())
  }, [checkFolder])

  useEffect(() => {
    void checkAll()
  }, [checkAll])

  // While this page is mounted it re-reads what an update changed, and the
  // extension is checked again whatever that re-read came to.
  useEffect(
    () =>
      updateRuns.attachReader(async (folder) => {
        try {
          await latest.current.afterUpdate(folder)
        } finally {
          await checkFolder(folder)
        }
      }),
    [checkFolder],
  )

  const steps: UpdateSteps = useMemo(
    () => ({
      take: (folder) => takeUpdate(folder, latest.current.findings.installed[folder]),
      reread: updateRuns.reread,
      record: updateRuns.record,
    }),
    [],
  )

  /**
   * Take one update, wherever it was asked for. Listed in the updates list when
   * the check had offered it, or when the list already shows it — a retried row
   * whose re-check now says it cannot update still shows how the retry went.
   */
  const update = useCallback(
    (folder: string): Promise<UpdateResult> => {
      const entry = latest.current.entries.find((candidate) => candidate.folder === folder)
      const finding = entry ? updateFinding(entry, latest.current.findings) : null
      const listed = latest.current.outcomes[folder]
      const span = finding && !('reason' in finding) ? finding : listed ? { from: listed.from, to: listed.to } : null
      return takeOne(folder, span, steps)
    },
    [steps],
  )

  // The run belongs to the tab: it goes on when the page is unmounted, and the
  // page mounted next shows it.
  const updateAll = useCallback(async (): Promise<UpdateAllSummary> => {
    const queue = takeableUpdates(latest.current.overview.updates)
    const skipped = latest.current.overview.blocked.length
    const tally = await runUpdates(queue, { ...steps, progress: updateRuns.progress })
    return { ...tally, skipped }
  }, [steps])

  return {
    installed,
    local,
    overview,
    /** The count on the toolbar button. */
    available: takeableUpdates(overview.updates).length,
    checking: checkingFolders.size > 0,
    isChecking: (folder: string) => checkingFolders.has(folder),
    checkedAt,
    progress,
    running,
    checkFolder,
    checkAll,
    update,
    updateAll,
  }
}
