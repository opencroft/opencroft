'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from 'ui/alert-dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { Flex } from 'ui/layout/flex'
import { Spinner } from 'ui/spinner'

import {
  checkInstalledForUpdates,
  getInstalledExtension,
  type InstalledExtensionRecord,
  type InstalledExtensionSummary,
  listInstalledExtensionSummaries,
  type UpdateCheck,
  uninstallExtension,
  updateInstalledExtension,
} from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import {
  checkLocalExtensionRemote,
  createLocalExtension,
  deleteLocalExtension,
  getLocalExtension,
  type LocalExtensionRecord,
  type LocalExtensionSummary,
  type LocalRemoteState,
  listLocalExtensionSummaries,
  pullLocalExtension,
} from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'
import {
  ExtensionDetail,
  type ExtensionRecord,
  type ExtensionSummary,
  isInstalledRecord,
} from '@/app/_authed/(extension-editor)/_components/extension-detail'
import { ExtensionSourceEditor } from '@/app/_authed/(extension-editor)/_components/extension-source-editor'
import { ExtensionsListPanel } from '@/app/_authed/(extension-editor)/_components/extensions-list-panel'
import { InstallExtensionDialog } from '@/app/_authed/(extension-editor)/_components/install-extension-dialog'
import { extensionTemplate } from '@/app/_authed/(extension-editor)/_templates/template'

function pickUntitledSlug(existing: { slug: string }[]): string {
  const taken = new Set(existing.map((r) => r.slug))
  let i = 1
  while (taken.has(i === 1 ? 'untitled' : `untitled-${i}`)) {
    i += 1
  }
  return i === 1 ? 'untitled' : `untitled-${i}`
}

function isInstalledId(extensionId: string): boolean {
  return extensionId.startsWith('installed/')
}

// The extensions section: the list on the left, and what is selected on the
// right. A row press opens the extension's PAGE — what it is, what it
// contributes and where its source stands — and editing, updating and deleting
// are acts offered there, with the extension in front of you.
//
// The list loads SUMMARIES: the same records without their files. One
// extension in this instance ships a 27 MB WebAssembly build, and reading
// every file of every extension to draw nine names made the response 140 MB
// and the page look empty for as long as it took to arrive. Files are read for
// the one extension that is opened.
//
// The editor takes the whole surface when it opens, like the design kit's
// does: three panes need the room, and the way back is the header's own.
export default function ExtensionsPage() {
  const [records, setRecords] = useState<LocalExtensionSummary[]>([])
  const [installed, setInstalled] = useState<InstalledExtensionSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [updateChecks, setUpdateChecks] = useState<Record<string, UpdateCheck>>({})
  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<ExtensionRecord | null>(null)
  const [selectedLoading, setSelectedLoading] = useState(false)
  const [remote, setRemote] = useState<LocalRemoteState | null>(null)
  const [remoteChecking, setRemoteChecking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ExtensionSummary | null>(null)

  const refresh = useCallback(async (): Promise<{
    local: LocalExtensionSummary[]
    installed: InstalledExtensionSummary[]
  }> => {
    const [local, installedList] = await Promise.all([listLocalExtensionSummaries(), listInstalledExtensionSummaries()])
    setRecords(local)
    setInstalled(installedList)
    setListLoading(false)
    return { local, installed: installedList }
  }, [])

  const checkAllUpdates = useCallback(async (list: InstalledExtensionSummary[]) => {
    const results = await Promise.all(
      list.map(async (record) => {
        try {
          return [record.id, await checkInstalledForUpdates({ data: record.id })] as const
        } catch {
          return null
        }
      }),
    )
    const map: Record<string, UpdateCheck> = {}
    for (const entry of results) {
      if (entry) {
        map[entry[0]] = entry[1]
      }
    }
    setUpdateChecks(map)
  }, [])

  useEffect(() => {
    refresh()
      .then(({ installed: list }) => {
        checkAllUpdates(list)
      })
      .catch((err) => {
        setListLoading(false)
        toast.error(err instanceof Error ? err.message : String(err))
      })
  }, [refresh, checkAllUpdates])

  // The open extension, with its files. Loaded per selection rather than with
  // the list, which is what keeps the list cheap.
  const loadSelected = useCallback(async (extensionId: string): Promise<ExtensionRecord | null> => {
    return isInstalledId(extensionId)
      ? await getInstalledExtension({ data: extensionId })
      : await getLocalExtension({ data: extensionId })
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setSelected(null)
      setRemote(null)
      return
    }
    let active = true
    setSelectedLoading(true)
    loadSelected(selectedId)
      .then((record) => {
        if (active) {
          setSelected(record)
        }
      })
      .catch((err) => {
        if (active) {
          setSelected(null)
          toast.error(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (active) {
          setSelectedLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [selectedId, loadSelected])

  // Where the open checkout stands against origin. One round trip, for the one
  // extension on screen — never for the list, which would make opening the
  // page wait on the network once per extension.
  const checkRemote = useCallback(async (extensionId: string) => {
    setRemoteChecking(true)
    try {
      setRemote(await checkLocalExtensionRemote({ data: extensionId }))
    } catch (err) {
      setRemote({
        branch: null,
        localCommit: null,
        remoteCommit: null,
        behind: false,
        blocked: null,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRemoteChecking(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedId || isInstalledId(selectedId)) {
      setRemote(null)
      return
    }
    setRemote(null)
    void checkRemote(selectedId)
  }, [selectedId, checkRemote])

  const selectedSummary = useMemo<ExtensionSummary | null>(
    () => records.find((r) => r.id === selectedId) ?? installed.find((r) => r.id === selectedId) ?? null,
    [records, installed, selectedId],
  )

  const handleSelect = useCallback((extensionId: string) => {
    setSelectedId(extensionId)
    setEditing(false)
  }, [])

  // A save in the editor makes the list's copy of that extension stale — the
  // manifest it was renamed in, the files the detail page counts.
  const handleSaved = useCallback((saved: LocalExtensionRecord) => {
    setSelected((current) => (current && current.id === saved.id ? saved : current))
    setRecords((prev) =>
      prev.map((record) => {
        if (record.id !== saved.id) {
          return record
        }
        const { files: _files, ...summary } = saved
        return summary
      }),
    )
  }, [])

  const handleNew = useCallback(async () => {
    setBusy(true)
    try {
      const slug = pickUntitledSlug(await listLocalExtensionSummaries())
      const record = await createLocalExtension({ data: extensionTemplate(slug) })
      await refresh()
      setSelectedId(record.id)
      // Straight into the editor: a template has nothing to read about yet,
      // and writing it is the only reason it was created.
      setEditing(true)
      toast.success(`Created ${record.manifest.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const handleInstalled = useCallback(
    async (record: InstalledExtensionRecord) => {
      const { installed: list } = await refresh()
      setSelectedId(record.id)
      setEditing(false)
      checkAllUpdates(list)
    },
    [refresh, checkAllUpdates],
  )

  // Two different acts under one control, because they are the same intention:
  // an installed extension is reinstalled at the newest tag, and a local
  // checkout is fast-forwarded to its branch on origin and rebuilt.
  const handleUpdate = useCallback(async () => {
    if (!selectedId) {
      return
    }
    setBusy(true)
    try {
      if (isInstalledId(selectedId)) {
        const check = updateChecks[selectedId]
        const record = await updateInstalledExtension({
          data: { extensionId: selectedId, ref: check?.latest ?? undefined },
        })
        const { installed: list } = await refresh()
        checkAllUpdates(list)
        setSelected(await loadSelected(selectedId))
        toast.success(`Updated ${record.manifest.name ?? record.id} to ${record.sidecar.ref}`)
      } else {
        const result = await pullLocalExtension({ data: selectedId })
        await refresh()
        setSelected(result.record)
        void checkRemote(selectedId)
        if (!result.moved) {
          toast.info('Already up to date.')
        } else if (result.build.success) {
          toast.success(`Updated to ${result.to?.slice(0, 7)} and rebuilt`)
        } else {
          // The files moved and the build did not: saying "update failed"
          // would describe a checkout that did update.
          toast.error(
            `Updated to ${result.to?.slice(0, 7)}, but the rebuild failed: ${result.build.errors[0]?.message ?? 'see the editor'}`,
          )
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [selectedId, updateChecks, refresh, checkAllUpdates, loadSelected, checkRemote])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) {
      return
    }
    const target = deleteTarget
    setDeleteTarget(null)
    setBusy(true)
    try {
      if (isInstalledRecord(target)) {
        await uninstallExtension({ data: target.id })
      } else {
        await deleteLocalExtension({ data: target.id })
      }
      const { installed: list } = await refresh()
      if (selectedId === target.id) {
        setSelectedId(null)
        setEditing(false)
      }
      checkAllUpdates(list)
      toast.success(isInstalledRecord(target) ? 'Extension uninstalled' : 'Extension deleted')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [deleteTarget, selectedId, refresh, checkAllUpdates])

  if (editing) {
    return selected ? (
      <ExtensionSourceEditor
        key={selected.id}
        record={selected}
        onBack={() => setEditing(false)}
        onSaved={handleSaved}
      />
    ) : (
      <Flex expanded align='center' justify='center' className='h-full w-full'>
        <Spinner />
      </Flex>
    )
  }

  return (
    <Flex row expanded className='h-full min-h-0 w-full'>
      <ExtensionsListPanel
        records={records}
        installed={installed}
        updateChecks={updateChecks}
        selectedId={selectedId}
        loading={listLoading}
        onSelect={handleSelect}
        onNew={handleNew}
        onInstall={() => setInstallDialogOpen(true)}
        onInstalled={handleInstalled}
      />
      <InstallExtensionDialog
        open={installDialogOpen}
        onOpenChange={setInstallDialogOpen}
        onInstalled={handleInstalled}
      />

      {selected ? (
        <ExtensionDetail
          key={selected.id}
          record={selected}
          updateCheck={updateChecks[selected.id]}
          remote={remote}
          remoteChecking={remoteChecking}
          busy={busy}
          onEdit={() => setEditing(true)}
          onUpdate={() => void handleUpdate()}
          onDelete={() => setDeleteTarget(selectedSummary ?? selected)}
        />
      ) : selectedLoading ? (
        <Flex expanded align='center' justify='center' className='min-w-0'>
          <Spinner />
        </Flex>
      ) : (
        <Flex expanded align='center' justify='center' className='min-w-0'>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No extension selected</EmptyTitle>
              <EmptyDescription>
                Choose an extension to see what it provides, or create one with + to start from a template.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Flex>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget && isInstalledRecord(deleteTarget) ? 'Uninstall' : 'Delete'}{' '}
              {deleteTarget?.manifest.name ?? 'this extension'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && isInstalledRecord(deleteTarget)
                ? 'The installed copy is removed from this instance. Its nodes disappear from the palette, and graphs using them stop resolving until it is installed again.'
                : 'The extension directory and its files are deleted from this instance. Its nodes disappear from the palette, and this cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {deleteTarget && isInstalledRecord(deleteTarget) ? 'Uninstall' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Flex>
  )
}
