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

import {
  checkInstalledForUpdates,
  type InstalledExtensionRecord,
  listInstalledExtensions,
  type UpdateCheck,
  uninstallExtension,
  updateInstalledExtension,
} from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import {
  createLocalExtension,
  deleteLocalExtension,
  type LocalExtensionRecord,
  listLocalExtensions,
} from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'
import {
  ExtensionDetail,
  type ExtensionRecord,
  isInstalledRecord,
} from '@/app/_authed/(extension-editor)/_components/extension-detail'
import { ExtensionSourceEditor } from '@/app/_authed/(extension-editor)/_components/extension-source-editor'
import { ExtensionsListPanel } from '@/app/_authed/(extension-editor)/_components/extensions-list-panel'
import { InstallExtensionDialog } from '@/app/_authed/(extension-editor)/_components/install-extension-dialog'
import { extensionTemplate } from '@/app/_authed/(extension-editor)/_templates/template'

function pickUntitledSlug(existing: LocalExtensionRecord[]): string {
  const taken = new Set(existing.map((r) => r.slug))
  let i = 1
  while (taken.has(i === 1 ? 'untitled' : `untitled-${i}`)) {
    i += 1
  }
  return i === 1 ? 'untitled' : `untitled-${i}`
}

// The extensions section: the list on the left, and what is selected on the
// right. A row press opens the extension's PAGE — what it is, what it
// contributes and where its source stands — and editing and deleting are acts
// offered there, with the extension in front of you, rather than from a row.
//
// The editor takes the whole surface when it opens, like the design kit's
// does: three panes need the room, and the way back is the header's own.
export default function ExtensionsPage() {
  const [records, setRecords] = useState<LocalExtensionRecord[]>([])
  const [installed, setInstalled] = useState<InstalledExtensionRecord[]>([])
  const [updateChecks, setUpdateChecks] = useState<Record<string, UpdateCheck>>({})
  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ExtensionRecord | null>(null)

  const refresh = useCallback(async (): Promise<{
    local: LocalExtensionRecord[]
    installed: InstalledExtensionRecord[]
  }> => {
    const [local, installedList] = await Promise.all([listLocalExtensions(), listInstalledExtensions()])
    setRecords(local)
    setInstalled(installedList)
    return { local, installed: installedList }
  }, [])

  const checkAllUpdates = useCallback(async (list: InstalledExtensionRecord[]) => {
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
    refresh().then(({ installed: list }) => {
      checkAllUpdates(list)
    })
  }, [refresh, checkAllUpdates])

  const selected = useMemo<ExtensionRecord | null>(
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
    setRecords((prev) => prev.map((record) => (record.id === saved.id ? saved : record)))
  }, [])

  const handleNew = useCallback(async () => {
    setBusy(true)
    try {
      const list = await listLocalExtensions()
      const slug = pickUntitledSlug(list)
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

  const handleUpdate = useCallback(
    async (extensionId: string) => {
      const check = updateChecks[extensionId]
      setBusy(true)
      try {
        const record = await updateInstalledExtension({ data: { extensionId, ref: check?.latest ?? undefined } })
        const { installed: list } = await refresh()
        checkAllUpdates(list)
        toast.success(`Updated ${record.manifest.name ?? record.id} to ${record.sidecar.ref}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [updateChecks, refresh, checkAllUpdates],
  )

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

  if (editing && selected) {
    return (
      <ExtensionSourceEditor
        key={selected.id}
        record={selected}
        onBack={() => setEditing(false)}
        onSaved={handleSaved}
      />
    )
  }

  return (
    <Flex row expanded className='h-full w-full min-h-0'>
      <ExtensionsListPanel
        records={records}
        installed={installed}
        updateChecks={updateChecks}
        selectedId={selectedId}
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
          busy={busy}
          onEdit={() => setEditing(true)}
          onUpdate={() => handleUpdate(selected.id)}
          onDelete={() => setDeleteTarget(selected)}
        />
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
