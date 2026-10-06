import type { BlockedExtensionUpdate, ExtensionUpdate, ExtensionUpdateState } from 'ui/extensions/extension-updates'

import type { ExtensionIndexEntry } from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import type {
  UpdateCheck,
  UpdateCheckFailure,
} from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import type { LocalRemoteState } from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'

// What the Extensions page says about updates, derived from what its checks
// found: which extensions have one, where it goes, and which have something
// newer they cannot take. One derivation for the list's badges, the updates
// list and the count on the toolbar button, so the three cannot disagree.

/** Where an update went, or is going. Kept with the versions it was taken between, so it stays readable after a re-check. */
export interface UpdateOutcome {
  state: Exclude<ExtensionUpdateState, 'available'>
  from: string
  to: string
  message?: string
}

export interface UpdateFindings {
  installed: Record<string, UpdateCheck>
  /** Installed extensions whose check failed, with what it said. */
  installedErrors: Record<string, UpdateCheckFailure>
  local: Record<string, LocalRemoteState>
}

/**
 * An update on offer, as the list writes it, or the reason it cannot be taken
 * — with what git said, when a check of the remote is what failed.
 */
export type UpdateFinding = { from: string; to: string } | { reason: string; detail?: string }

export function shortCommit(commit: string | null | undefined): string {
  return commit ? commit.slice(0, 7) : '?'
}

/** A ref as the page writes it: a tag as it is, a branch with the commit it is at. */
export function refLabel(ref: string | null, commit: string | null, isBranch: boolean): string {
  return isBranch ? `${ref ?? '?'} · ${shortCommit(commit)}` : (ref ?? '?')
}

/** Where an installed extension's update takes it. */
export function updateTarget(check: UpdateCheck): string {
  return refLabel(check.latest, check.latestCommit, check.followsBranch)
}

function installedFinding(folder: string, findings: UpdateFindings): UpdateFinding | null {
  const failure = findings.installedErrors[folder]
  if (failure) {
    return { reason: `The check failed: ${failure.error}`, ...(failure.detail ? { detail: failure.detail } : {}) }
  }
  const check = findings.installed[folder]
  if (!check?.hasUpdate) {
    return null
  }
  return { from: refLabel(check.current, check.currentCommit, check.followsBranch), to: updateTarget(check) }
}

function localFinding(state: LocalRemoteState | undefined): UpdateFinding | null {
  if (!state) {
    return null
  }
  if (state.error) {
    // A folder that is not a git checkout has nothing to follow; that is what
    // it is, not a check that failed.
    if (!state.localCommit) {
      return null
    }
    return { reason: state.error, ...(state.errorDetail ? { detail: state.errorDetail } : {}) }
  }
  if (state.behind) {
    return state.blocked
      ? { reason: state.blocked }
      : { from: refLabel(state.branch, state.localCommit, true), to: refLabel(state.branch, state.remoteCommit, true) }
  }
  // A detached checkout is never asked about origin, so whether it is behind
  // is unknown; it is listed for the reason it is not checked.
  if (state.blocked && (state.branch === null || state.branch === 'HEAD')) {
    return { reason: state.blocked }
  }
  return null
}

/** What the checks found for one extension: an update, a reason it cannot take one, or nothing to say. */
export function updateFinding(entry: ExtensionIndexEntry, findings: UpdateFindings): UpdateFinding | null {
  if (entry.missing) {
    return null
  }
  return entry.kind === 'installed'
    ? installedFinding(entry.folder, findings)
    : localFinding(findings.local[entry.folder])
}

/**
 * The updates list. An extension with an outcome is listed with it, between
 * the versions it was taken between, whatever a later check of it says: the
 * outcome stays on screen until the next check of everything.
 */
export function updateOverview(
  entries: ExtensionIndexEntry[],
  findings: UpdateFindings,
  outcomes: Record<string, UpdateOutcome>,
): { updates: ExtensionUpdate[]; blocked: BlockedExtensionUpdate[] } {
  const updates: ExtensionUpdate[] = []
  const blocked: BlockedExtensionUpdate[] = []
  for (const entry of entries) {
    const outcome = outcomes[entry.folder]
    if (outcome) {
      updates.push({ id: entry.folder, name: entry.name, ...outcome })
      continue
    }
    const finding = updateFinding(entry, findings)
    if (!finding) {
      continue
    }
    if ('reason' in finding) {
      blocked.push({ id: entry.folder, name: entry.name, ...finding })
    } else {
      updates.push({ id: entry.folder, name: entry.name, ...finding, state: 'available' })
    }
  }
  return { updates, blocked }
}

/** The updates that can be taken now: the toolbar button's count, and what Update all runs. */
export function takeableUpdates(updates: ExtensionUpdate[]): ExtensionUpdate[] {
  return updates.filter((update) => update.state === 'available' || update.state === 'failed')
}
