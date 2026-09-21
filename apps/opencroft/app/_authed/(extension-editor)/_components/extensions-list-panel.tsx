'use client'

import { Box, Download, Loader2, Plus, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'
import { Input } from 'ui/input'
import { ScrollArea } from 'ui/layout/scroll-area'
import { Separator } from 'ui/separator'

import type { ExtensionIndexEntry } from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import type {
  InstalledExtensionRecord,
  UpdateCheck,
} from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import {
  installRegistryExtension,
  listRegistryExtensions,
} from '@/app/_authed/(extension-editor)/_actions/registry-actions'
import type { RegistryExtension } from '@/app/_authed/(extension-runtime)/_server/registry'
import { cn } from '@/lib/utils'

// The index of what is installed on this instance, and the way to add more.
// Rows are NAVIGATION and nothing else: what an extension is, and every act on
// it — edit, update, uninstall — belongs to its own page, where the extension
// being acted on is the thing on screen rather than one row of thirty.
interface ExtensionsListPanelProps {
  local: ExtensionIndexEntry[]
  installed: ExtensionIndexEntry[]
  updateChecks: Record<string, UpdateCheck>
  selectedId: string | null
  onSelect: (extensionId: string) => void
  onNew: () => void
  onInstall: () => void
  onInstalled: (record: InstalledExtensionRecord) => void
}

export function ExtensionsListPanel({
  local,
  installed,
  updateChecks,
  selectedId,
  onSelect,
  onNew,
  onInstall,
  onInstalled,
}: ExtensionsListPanelProps) {
  const [query, setQuery] = useState('')
  const [registryResults, setRegistryResults] = useState<(RegistryExtension & { registryName: string })[]>([])
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  const hasQuery = query.trim().length > 0
  const installedRepos = new Set(installed.map((entry) => entry.sourceUrl).filter(Boolean))

  const doSearch = useCallback(async (q: string) => {
    setSearching(true)
    try {
      const results = await listRegistryExtensions({ data: q })
      setRegistryResults(results)
    } catch {
      toast.error('Failed to search registries')
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    if (!hasQuery) {
      setRegistryResults([])
      return
    }
    const timer = setTimeout(() => doSearch(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleInstallFromRegistry(ext: RegistryExtension) {
    setInstalling(ext.id)
    try {
      const record = await installRegistryExtension({ data: { extensionId: ext.id } })
      toast.success(`Installed ${record.manifest.name ?? record.id}`)
      onInstalled(record)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(null)
    }
  }

  return (
    <aside className='w-60 h-full border-r bg-card flex flex-col shrink-0'>
      {/* Header */}
      <div className='flex items-center gap-1 p-3'>
        <span className='text-sm font-semibold flex-1'>Extensions</span>
        <Button size='icon' variant='ghost' className='size-6' onClick={onInstall} title='Install from URL'>
          <Download className='size-3.5' />
        </Button>
        <Button size='icon' variant='ghost' className='size-6' onClick={onNew} title='New local extension'>
          <Plus className='size-3.5' />
        </Button>
      </div>

      {/* Search */}
      <div className='flex items-center gap-1 px-2 pb-2'>
        <div className='relative flex-1'>
          <Search className='absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground' />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search extensions...'
            className='h-7 text-xs pl-7'
          />
        </div>
        {searching && <Loader2 className='size-3.5 animate-spin shrink-0 text-muted-foreground' />}
      </div>

      <Separator />

      {/* List */}
      <ScrollArea className='flex-1 min-h-0'>
        {hasQuery ? (
          /* Registry search results */
          <>
            <div className='px-3 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground'>Registry</div>
            {registryResults.length === 0 && !searching && (
              <div className='px-3 py-2 text-xs text-muted-foreground italic'>No extensions found.</div>
            )}
            {registryResults.map((ext) => {
              const isInstalled = installedRepos.has(ext.repository)
              const isBusy = installing === ext.id

              return (
                <div
                  key={`${ext.registryName}/${ext.id}`}
                  className='group flex items-center px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors'
                >
                  <div className='flex-1 flex items-center gap-2 min-w-0'>
                    <Box className='size-3.5 shrink-0' />
                    <span className='truncate'>{ext.name}</span>
                  </div>
                  {isInstalled ? (
                    <span className='text-[10px] text-muted-foreground shrink-0'>installed</span>
                  ) : (
                    <Button
                      size='icon'
                      variant='ghost'
                      className='size-5 opacity-60'
                      onClick={() => handleInstallFromRegistry(ext)}
                      disabled={isBusy}
                      title={`Install ${ext.name}`}
                    >
                      {isBusy ? <Loader2 className='size-3 animate-spin' /> : <Download className='size-3' />}
                    </Button>
                  )}
                </div>
              )
            })}
          </>
        ) : (
          /* Local + Installed when no search query */
          <>
            {local.length > 0 ? (
              <div>
                <div className='px-3 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground'>Local</div>
                {local.map((entry) => (
                  <button
                    key={entry.id}
                    type='button'
                    onClick={() => onSelect(entry.id)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/50',
                      selectedId === entry.id && 'bg-accent/60',
                    )}
                  >
                    <Box className='size-3.5 shrink-0' />
                    <span className='truncate'>{entry.name}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {installed.length > 0 ? (
              <div>
                <div className='px-3 pt-3 text-[10px] uppercase tracking-wider text-muted-foreground'>Installed</div>
                {installed.map((entry) => {
                  const check = updateChecks[entry.id]
                  const hasUpdate = check?.hasUpdate ?? false
                  return (
                    <button
                      key={entry.id}
                      type='button'
                      onClick={() => onSelect(entry.id)}
                      title={hasUpdate ? `${check?.latest} available` : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/50',
                        selectedId === entry.id && 'bg-accent/60',
                      )}
                    >
                      <Box className='size-3.5 shrink-0' />
                      <span className='min-w-0 flex-1 truncate'>{entry.name}</span>
                      {/* The version, amber when a newer one exists. Stated
                          rather than actioned: updating happens on the
                          extension's own page, where what it replaces is
                          visible. */}
                      <span
                        className={cn(
                          'shrink-0 text-[10px] tabular-nums',
                          hasUpdate ? 'text-amber-500' : 'text-muted-foreground',
                        )}
                      >
                        {entry.ref}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}
            {/* No loading state to distinguish this from: the list arrives
                with the page, so an empty one is an empty instance. */}
            {local.length === 0 && installed.length === 0 ? (
              <div className='px-3 py-4 text-xs text-muted-foreground italic'>
                No extensions yet. Click + to create or search to find extensions.
              </div>
            ) : null}
          </>
        )}
      </ScrollArea>
    </aside>
  )
}
