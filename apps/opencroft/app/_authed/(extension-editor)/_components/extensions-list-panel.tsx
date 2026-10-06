'use client'

import { cn } from 'cn'
import { Box } from 'lucide-react'
import { Badge } from 'ui/badge'
import { ScrollArea } from 'ui/layout/scroll-area'

import type { ExtensionIndexEntry } from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import type { UpdateCheck } from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import type { LocalRemoteState } from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'
import { shortCommit, updateTarget } from '@/app/_authed/(extension-editor)/_components/update-overview'

// The index of what is on this instance.
// Rows are NAVIGATION and nothing else: what an extension is, and every act on
// it — edit, update, uninstall — belongs to its own page, where the extension
// being acted on is the thing on screen rather than one row of thirty.
//
// Rows are keyed by folder: it is the one name every entry has, including a
// folder that does not run (its id is served by another folder, or its manifest
// claims one it may not use) and a recorded install whose folder is gone. Such a
// row says why under its name.
interface ExtensionsListPanelProps {
  local: ExtensionIndexEntry[]
  installed: ExtensionIndexEntry[]
  updateChecks: Record<string, UpdateCheck>
  localStates: Record<string, LocalRemoteState>
  selectedFolder: string | null
  onSelect: (folder: string) => void
}

const ROW_BADGE_CLASS = 'h-4 px-1.5 text-[10px]'
const ROW_BADGE_AMBER_CLASS = cn(ROW_BADGE_CLASS, 'border-amber-500/50 text-amber-600')

/**
 * A local row's version, then what the instance runs it from: a local folder,
 * whether that folder's checkout carries uncommitted changes, and whether
 * origin has moved past it.
 */
function LocalEntryState({ entry, state }: { entry: ExtensionIndexEntry; state: LocalRemoteState | undefined }) {
  return (
    <span className='flex shrink-0 items-center gap-1'>
      <span className='text-[10px] tabular-nums text-muted-foreground'>{entry.version}</span>
      <Badge variant='outline' className={ROW_BADGE_CLASS}>
        Local
      </Badge>
      {entry.dirty ? (
        <Badge variant='outline' className={ROW_BADGE_AMBER_CLASS}>
          Dirty
        </Badge>
      ) : null}
      {state?.behind ? (
        <Badge variant='outline' className={ROW_BADGE_AMBER_CLASS} title={`origin/${state.branch} has newer commits`}>
          Behind
        </Badge>
      ) : null}
    </span>
  )
}

/** An installed row's ref, then where its update goes when it has one. */
function InstalledEntryState({ entry, check }: { entry: ExtensionIndexEntry; check: UpdateCheck | undefined }) {
  return (
    <span className='flex shrink-0 items-center gap-1'>
      <span className='text-[10px] tabular-nums text-muted-foreground'>{entry.ref}</span>
      {check?.hasUpdate ? (
        <Badge variant='outline' className={ROW_BADGE_AMBER_CLASS} title={`${updateTarget(check)} available`}>
          ↑ {check.followsBranch ? shortCommit(check.latestCommit) : check.latest}
        </Badge>
      ) : null}
    </span>
  )
}

/** A row's name, with the reason under it when the extension is not running. */
function EntryLabel({ entry }: { entry: ExtensionIndexEntry }) {
  return (
    <span className='min-w-0 flex-1'>
      <span className='block truncate'>{entry.name}</span>
      {entry.error ? <span className='block truncate text-[10px] text-destructive'>{entry.error}</span> : null}
    </span>
  )
}

export function ExtensionsListPanel({
  local,
  installed,
  updateChecks,
  localStates,
  selectedFolder,
  onSelect,
}: ExtensionsListPanelProps) {
  return (
    <aside className='w-60 h-full border-r bg-card flex flex-col shrink-0'>
      <ScrollArea className='flex-1 min-h-0'>
        {local.length > 0 ? (
          <div>
            <div className='px-3 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground'>Local</div>
            {local.map((entry) => (
              <button
                key={entry.folder}
                type='button'
                onClick={() => onSelect(entry.folder)}
                title={entry.error}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/50',
                  selectedFolder === entry.folder && 'bg-accent/60',
                )}
              >
                <Box className='size-3.5 shrink-0' />
                <EntryLabel entry={entry} />
                <LocalEntryState entry={entry} state={localStates[entry.folder]} />
              </button>
            ))}
          </div>
        ) : null}
        {installed.length > 0 ? (
          <div>
            <div className='px-3 pt-3 text-[10px] uppercase tracking-wider text-muted-foreground'>Installed</div>
            {installed.map((entry) => (
              <button
                key={entry.folder}
                type='button'
                onClick={() => onSelect(entry.folder)}
                title={entry.error}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/50',
                  selectedFolder === entry.folder && 'bg-accent/60',
                )}
              >
                <Box className='size-3.5 shrink-0' />
                <EntryLabel entry={entry} />
                {/* Stated rather than actioned: an update is taken on the
                    extension's own page, or from the updates list, where
                    what it replaces is visible. */}
                <InstalledEntryState entry={entry} check={updateChecks[entry.folder]} />
              </button>
            ))}
          </div>
        ) : null}
        {/* No loading state to distinguish this from: the list arrives
            with the page, so an empty one is an empty instance. */}
        {local.length === 0 && installed.length === 0 ? (
          <div className='px-3 py-4 text-xs text-muted-foreground italic'>
            No extensions yet. Click + to create or search to find extensions.
          </div>
        ) : null}
      </ScrollArea>
    </aside>
  )
}
