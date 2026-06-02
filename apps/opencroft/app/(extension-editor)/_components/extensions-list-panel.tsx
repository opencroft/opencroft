'use client'

import { ArrowDownToLine, Box, Download, Loader2, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import type { InstalledExtensionRecord, UpdateCheck } from '@/app/(extension-editor)/_actions/installed-extensions-actions'
import type { LocalExtensionRecord } from '@/app/(extension-editor)/_actions/local-extensions-actions'
import { installRegistryExtension, listRegistryExtensions } from '@/app/(extension-editor)/_actions/registry-actions'
import type { RegistryExtension } from '@/app/(extension-runtime)/_server/registry'
import { Button } from '@opencroft/ui-kit/button'
import { Input } from '@opencroft/ui-kit/input'
import { ScrollArea } from '@opencroft/ui-kit/layout/scroll-area'
import { Separator } from '@opencroft/ui-kit/separator'
import { cn } from '@/lib/utils'

interface ExtensionsListPanelProps {
  records: LocalExtensionRecord[]
  installed: InstalledExtensionRecord[]
  updateChecks: Record<string, UpdateCheck>
  selectedId: string | null
  onSelect: (extensionId: string) => void
  onNew: () => void
  onInstall: () => void
  onDelete: (extensionId: string) => void
  onUpdate: (extensionId: string) => void
  onUninstall: (extensionId: string) => void
  onInstalled: (record: InstalledExtensionRecord) => void
}

export function ExtensionsListPanel({ records, installed, updateChecks, selectedId, onSelect, onNew, onInstall, onDelete, onUpdate, onUninstall, onInstalled }: ExtensionsListPanelProps) {
  const [query, setQuery] = useState('')
  const [registryResults, setRegistryResults] = useState<(RegistryExtension & { registryName: string })[]>([])
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  const hasQuery = query.trim().length > 0
  const installedRepos = new Set(installed.map((r) => r.sidecar.source.url))

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
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder='Search extensions...' className='h-7 text-xs pl-7' />
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
            {registryResults.length === 0 && !searching && <div className='px-3 py-2 text-xs text-muted-foreground italic'>No extensions found.</div>}
            {registryResults.map((ext) => {
              const isInstalled = installedRepos.has(ext.repository)
              const isBusy = installing === ext.id

              return (
                <div key={`${ext.registryName}/${ext.id}`} className='group flex items-center px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors'>
                  <div className='flex-1 flex items-center gap-2 min-w-0'>
                    <Box className='size-3.5 shrink-0' />
                    <span className='truncate'>{ext.name}</span>
                  </div>
                  {isInstalled ? (
                    <span className='text-[10px] text-muted-foreground shrink-0'>installed</span>
                  ) : (
                    <Button size='icon' variant='ghost' className='size-5 opacity-60' onClick={() => handleInstallFromRegistry(ext)} disabled={isBusy} title={`Install ${ext.name}`}>
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
            {records.length > 0 ? (
              <div>
                <div className='px-3 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground'>Local</div>
                {records.map((record) => {
                  const isSelected = selectedId === record.id
                  return (
                    <div key={record.id} className={cn('group flex items-center px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors', isSelected && 'bg-accent/60')}>
                      <button onClick={() => onSelect(record.id)} className='flex-1 flex items-center gap-2 text-left min-w-0'>
                        <Box className='size-3.5 shrink-0' />
                        <span className='truncate'>{record.manifest.name}</span>
                      </button>
                      <Button
                        size='icon'
                        variant='ghost'
                        className='size-5 opacity-60 text-muted-foreground hover:text-destructive'
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(record.id)
                        }}
                        title='Delete extension'
                      >
                        <Trash2 className='size-3' />
                      </Button>
                    </div>
                  )
                })}
              </div>
            ) : null}
            {installed.length > 0 ? (
              <div>
                <div className='px-3 pt-3 text-[10px] uppercase tracking-wider text-muted-foreground'>Installed</div>
                {installed.map((record) => {
                  const isSelected = selectedId === record.id
                  const check = updateChecks[record.id]
                  const hasUpdate = check?.hasUpdate ?? false
                  return (
                    <div key={record.id} className={cn('group flex items-center px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors', isSelected && 'bg-accent/60')}>
                      <button onClick={() => onSelect(record.id)} className='flex-1 flex items-center gap-2 text-left min-w-0' title={record.sidecar.source.name}>
                        <Box className='size-3.5 shrink-0' />
                        <span className='truncate flex-1'>{record.manifest.name}</span>
                        <span className={cn('shrink-0 text-[10px] tabular-nums', hasUpdate ? 'text-amber-500' : 'text-muted-foreground')}>{record.sidecar.ref}</span>
                      </button>
                      {hasUpdate ? (
                        <Button
                          size='icon'
                          variant='ghost'
                          className='size-5 text-amber-500 hover:text-amber-400'
                          onClick={(e) => {
                            e.stopPropagation()
                            onUpdate(record.id)
                          }}
                          title={`Update to ${check?.latest}`}
                        >
                          <ArrowDownToLine className='size-3' />
                        </Button>
                      ) : (
                        <Button
                          size='icon'
                          variant='ghost'
                          className='size-5 opacity-60 text-muted-foreground'
                          onClick={(e) => {
                            e.stopPropagation()
                            onUpdate(record.id)
                          }}
                          title='Reinstall current version'
                        >
                          <RefreshCw className='size-3' />
                        </Button>
                      )}
                      <Button
                        size='icon'
                        variant='ghost'
                        className='size-5 opacity-60 text-muted-foreground hover:text-destructive'
                        onClick={(e) => {
                          e.stopPropagation()
                          onUninstall(record.id)
                        }}
                        title='Uninstall'
                      >
                        <Trash2 className='size-3' />
                      </Button>
                    </div>
                  )
                })}
              </div>
            ) : null}
            {records.length === 0 && installed.length === 0 ? (
              <div className='px-3 py-4 text-xs text-muted-foreground italic'>No extensions yet. Click + to create or search to find extensions.</div>
            ) : null}
          </>
        )}
      </ScrollArea>
    </aside>
  )
}
