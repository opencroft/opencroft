'use client'

import { useRouter } from '@tanstack/react-router'
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
  type ExtensionIndexEntry,
  listExtensionsIndex,
} from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import {
  checkInstalledForUpdates,
  getInstalledExtension,
  type InstalledExtensionRecord,
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
  type LocalRemoteState,
  pullLocalExtension,
} from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'
import { ExtensionDetail, type ExtensionRecord } from '@/app/_authed/(extension-editor)/_components/extension-detail'
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

interface ExtensionsPageProps {
  /** The list, as the route's loader read it — on screen from the first paint. */
  index: ExtensionIndexEntry[]
}

// The extensions section: the list on the left, and what is selected on the
// right. A row press opens the extension's PAGE — what it is, what it
// contributes and where its source stands — and editing, updating and deleting
// are acts offered there, with the extension in front of you.
//
// The list is an INDEX — ids, names, versions — and it arrives with the
// document, from the manifest cache the instance already keeps. Everything
// heavier is read for the one extension somebody opens: its files, its
// checkout, what it is running, where it stands against origin. Acts refresh
// the index rather than re-reading the world.
//
// The editor takes the whole surface when it opens, like the design kit's
// does: three panes need the room, and the way back is the header's own.
export default function ExtensionsPage({ index }: ExtensionsPageProps) {
  const router = useRouter()
  const [entries, setEntries] = useState<ExtensionIndexEntry[]>(index)
  const [updateChecks, setUpdateChecks] = useState<Record<string, UpdateCheck>>({})
  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<ExtensionRecord | null>(null)
  const [selectedLoading, setSelectedLoading] = useState(false)
  const [remote, setRemote] = useState<LocalRemoteState | null>(null)
  const [remoteChecking, setRemoteChecking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ExtensionIndexEntry | null>(null)

  // The loader is the source; this state is what acts on this page update in
  // between its runs. Navigating back to the route re-runs the loader, and the
  // list follows it rather than holding an older copy.
  useEffect(() => {
    setEntries(index)
  }, [index])

  const localEntries = useMemo(() => entries.filter((entry) => entry.kind === 'local'), [entries])
  const installedEntries = useMemo(() => entries.filter((entry) => entry.kind === 'installed'), [entries])

  const refresh = useCallback(async (): Promise<ExtensionIndexEntry[]> => {
    const next = await listExtensionsIndex()
    setEntries(next)
    // The loader's copy is now stale, and it is what a later navigation to this
    // route would draw. Not awaited: the list on screen is already current.
    void router.invalidate()
    return next
  }, [router])

  const checkAllUpdates = useCallback(async (list: ExtensionIndexEntry[]) => {
    const results = await Promise.all(
      list.map(async (entry) => {
        try {
          return [entry.id, await checkInstalledForUpdates({ data: entry.id })] as const
        } catch {
          return null
        }
      }),
    )
    const map: Record<string, UpdateCheck> = {}
    for (const result of results) {
      if (result) {
        map[result[0]] = result[1]
      }
    }
    setUpdateChecks(map)
  }, [])

  // Installed extensions are checked against their remote once the page is up.
  // It is a network call per extension, so it never holds the list back — the
  // version a row shows is what is installed, and the amber says a newer tag
  // exists once the answer arrives.
  useEffect(() => {
    const installed = index.filter((entry) => entry.kind === 'installed')
    if (installed.length > 0) {
      void checkAllUpdates(installed)
    }
  }, [index, checkAllUpdates])

  // The open extension, with its files. Loaded per selection rather than with
  // the list, which is what keeps the list instant.
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

  const selectedEntry = useMemo(() => entries.find((entry) => entry.id === selectedId) ?? null, [entries, selectedId])

  const handleSelect = useCallback((extensionId: string) => {
    setSelectedId(extensionId)
    setEditing(false)
  }, [])

  // A save in the editor can rename the extension or move its version, and the
  // row beside it is drawn from the index. Updated in place rather than by
  // re-reading the list: the save already returned the record it wrote.
  const handleSaved = useCallback((saved: LocalExtensionRecord) => {
    setSelected((current) => (current && current.id === saved.id ? saved : current))
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === saved.id
          ? { ...entry, name: saved.manifest.name || entry.slug, version: saved.manifest.version }
          : entry,
      ),
    )
  }, [])

  const handleNew = useCallback(async () => {
    setBusy(true)
    try {
      const record = await createLocalExtension({ data: extensionTemplate(pickUntitledSlug(localEntries)) })
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
  }, [localEntries, refresh])

  const handleInstalled = useCallback(
    async (record: InstalledExtensionRecord) => {
      const next = await refresh()
      setSelectedId(record.id)
      setEditing(false)
      void checkAllUpdates(next.filter((entry) => entry.kind === 'installed'))
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
        const next = await refresh()
        void checkAllUpdates(next.filter((entry) => entry.kind === 'installed'))
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
      if (target.kind === 'installed') {
        await uninstallExtension({ data: target.id })
      } else {
        await deleteLocalExtension({ data: target.id })
      }
      await refresh()
      if (selectedId === target.id) {
        setSelectedId(null)
        setEditing(false)
      }
      toast.success(target.kind === 'installed' ? 'Extension uninstalled' : 'Extension deleted')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [deleteTarget, selectedId, refresh])

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
        local={localEntries}
        installed={installedEntries}
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
          remote={remote}
          remoteChecking={remoteChecking}
          busy={busy}
          onEdit={() => setEditing(true)}
          onUpdate={() => void handleUpdate()}
          onDelete={() => setDeleteTarget(selectedEntry)}
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
              {deleteTarget?.kind === 'installed' ? 'Uninstall' : 'Delete'} {deleteTarget?.name ?? 'this extension'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === 'installed'
                ? 'The installed copy is removed from this instance. Its nodes disappear from the palette, and graphs using them stop resolving until it is installed again.'
                : 'The extension directory and its files are deleted from this instance. Its nodes disappear from the palette, and this cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {deleteTarget?.kind === 'installed' ? 'Uninstall' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Flex>
  )
}
