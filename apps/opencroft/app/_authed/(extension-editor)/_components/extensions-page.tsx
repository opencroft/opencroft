'use client'

import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Button } from 'ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { Flex } from 'ui/layout/flex'
import { Spinner } from 'ui/spinner'

import {
  type ExtensionIndexEntry,
  listExtensionsIndex,
} from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import {
  checkInstalledForUpdates,
  getInstalledExtension,
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
import { isLocalFolder, localFolderFor } from '@/app/_authed/(extension-runtime)/_extension-id'

function pickUntitledSlug(folders: string[]): string {
  const taken = new Set(folders)
  let i = 1
  while (taken.has(localFolderFor(i === 1 ? 'untitled' : `untitled-${i}`))) {
    i += 1
  }
  return i === 1 ? 'untitled' : `untitled-${i}`
}

/** Whether there is a repository to ask about updates: the folder is there and its install recorded where it came from. */
function hasUpdateSource(entry: ExtensionIndexEntry): boolean {
  return !entry.missing && entry.sourceUrl !== undefined
}

// What taking an entry off the instance is called, and what it does. A recorded
// install whose folder is gone has only the record left to remove; an installed
// copy is uninstalled and a local extension is deleted with its files.
function removalVerb(entry: ExtensionIndexEntry): 'Remove' | 'Uninstall' | 'Delete' {
  if (entry.missing) {
    return 'Remove'
  }
  return entry.kind === 'installed' ? 'Uninstall' : 'Delete'
}

function removalOutcome(entry: ExtensionIndexEntry): string {
  const verb = removalVerb(entry)
  return verb === 'Remove' ? 'Extension removed' : verb === 'Uninstall' ? 'Extension uninstalled' : 'Extension deleted'
}

function removalDescription(entry: ExtensionIndexEntry | null): string {
  if (entry?.missing) {
    return 'The record of this install is removed from this instance. Nodes and apps that use it are kept.'
  }
  if (entry?.kind === 'installed') {
    return 'The installed copy is removed from this instance. Its nodes disappear from the palette, and graphs using them stop resolving until it is installed again.'
  }
  return 'The extension directory and its files are deleted from this instance. Its nodes disappear from the palette, and this cannot be undone.'
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
// The list is an INDEX — folders, names, versions — and it arrives with the
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
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [selected, setSelected] = useState<ExtensionRecord | null>(null)
  // The folder whose record has been asked for and answered. A selection is
  // loading from the render it is made in until this catches up with it, so an
  // entry that cannot be opened is never shown for the frame before its load starts.
  const [loadedFolder, setLoadedFolder] = useState<string | null>(null)
  const selectedLoading = selectedFolder !== null && loadedFolder !== selectedFolder
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
      list.filter(hasUpdateSource).map(async (entry) => {
        try {
          return [entry.folder, await checkInstalledForUpdates({ data: entry.folder })] as const
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
  const loadSelected = useCallback(async (folder: string): Promise<ExtensionRecord | null> => {
    return isLocalFolder(folder)
      ? await getLocalExtension({ data: folder })
      : await getInstalledExtension({ data: folder })
  }, [])

  useEffect(() => {
    if (!selectedFolder) {
      setSelected(null)
      setRemote(null)
      setLoadedFolder(null)
      return
    }
    let active = true
    loadSelected(selectedFolder)
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
          setLoadedFolder(selectedFolder)
        }
      })
    return () => {
      active = false
    }
  }, [selectedFolder, loadSelected])

  // Where the open checkout stands against origin. One round trip, for the one
  // extension on screen — never for the list, which would make opening the
  // page wait on the network once per extension.
  const checkRemote = useCallback(async (folder: string) => {
    setRemoteChecking(true)
    try {
      setRemote(await checkLocalExtensionRemote({ data: folder }))
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
    if (!selectedFolder || !isLocalFolder(selectedFolder)) {
      setRemote(null)
      return
    }
    setRemote(null)
    void checkRemote(selectedFolder)
  }, [selectedFolder, checkRemote])

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.folder === selectedFolder) ?? null,
    [entries, selectedFolder],
  )

  const handleSelect = useCallback((folder: string) => {
    setSelectedFolder(folder)
    setEditing(false)
  }, [])

  // A save in the editor can rename the extension or move its version, and the
  // row beside it is drawn from the index. Updated in place rather than by
  // re-reading the list: the save already returned the record it wrote. The
  // exception is a manifest that now claims another id: which folder serves
  // which id changed, and the rows of the other folders say so. The entries are
  // read through a ref so this callback keeps one identity — the editor's
  // autosave is scheduled from it.
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const handleSaved = useCallback(
    (saved: LocalExtensionRecord) => {
      setSelected((current) => (current && current.folder === saved.folder ? saved : current))
      setEntries((prev) =>
        prev.map((entry) =>
          entry.folder === saved.folder
            ? { ...entry, name: saved.manifest.name || entry.folder, version: saved.manifest.version }
            : entry,
        ),
      )
      if (entriesRef.current.some((entry) => entry.folder === saved.folder && entry.id !== saved.id)) {
        void refresh()
      }
    },
    [refresh],
  )

  const handleNew = useCallback(async () => {
    setBusy(true)
    try {
      const slug = pickUntitledSlug(localEntries.map((entry) => entry.folder))
      const record = await createLocalExtension({
        data: { folder: localFolderFor(slug), files: extensionTemplate(slug) },
      })
      await refresh()
      setSelectedFolder(record.folder)
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

  // An install landed in `folder`: the list is re-read and the new extension
  // opened, whatever kind of folder it went into.
  const handleInstalled = useCallback(
    async (folder: string) => {
      const next = await refresh()
      setSelectedFolder(folder)
      setEditing(false)
      void checkAllUpdates(next.filter((entry) => entry.kind === 'installed'))
    },
    [refresh, checkAllUpdates],
  )

  // Two different acts under one control, because they are the same intention:
  // an installed extension is reinstalled at the newest tag, and a local
  // checkout is fast-forwarded to its branch on origin and rebuilt.
  const handleUpdate = useCallback(async () => {
    if (!selectedFolder) {
      return
    }
    setBusy(true)
    try {
      if (!isLocalFolder(selectedFolder)) {
        const check = updateChecks[selectedFolder]
        const record = await updateInstalledExtension({
          data: { folder: selectedFolder, ref: check?.latest ?? undefined },
        })
        const next = await refresh()
        void checkAllUpdates(next.filter((entry) => entry.kind === 'installed'))
        setSelected(await loadSelected(selectedFolder))
        toast.success(`Updated ${record.manifest.name ?? record.id} to ${record.source?.ref ?? 'its newest version'}`)
      } else {
        const result = await pullLocalExtension({ data: selectedFolder })
        await refresh()
        setSelected(result.record)
        void checkRemote(selectedFolder)
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
  }, [selectedFolder, updateChecks, refresh, checkAllUpdates, loadSelected, checkRemote])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) {
      return
    }
    const target = deleteTarget
    setDeleteTarget(null)
    setBusy(true)
    try {
      if (target.kind === 'installed') {
        await uninstallExtension({ data: target.folder })
      } else {
        await deleteLocalExtension({ data: target.folder })
      }
      await refresh()
      if (selectedFolder === target.folder) {
        setSelectedFolder(null)
        setEditing(false)
      }
      toast.success(removalOutcome(target))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [deleteTarget, selectedFolder, refresh])

  if (editing) {
    return selected ? (
      <ExtensionSourceEditor
        key={selected.folder}
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
        selectedFolder={selectedFolder}
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
          key={selected.folder}
          record={selected}
          updateCheck={updateChecks[selected.folder]}
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
      ) : selectedEntry ? (
        // An entry the page cannot open — a recorded install whose folder is
        // gone, or a manifest that cannot be read. What is left to do with it
        // is take it off the instance.
        <Flex expanded align='center' justify='center' className='min-w-0'>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{selectedEntry.name}</EmptyTitle>
              <EmptyDescription>{selectedEntry.error ?? 'This extension cannot be opened.'}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size='sm' variant='outline' disabled={busy} onClick={() => setDeleteTarget(selectedEntry)}>
                {removalVerb(selectedEntry)}
              </Button>
            </EmptyContent>
          </Empty>
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
              {deleteTarget ? removalVerb(deleteTarget) : 'Delete'} {deleteTarget?.name ?? 'this extension'}?
            </AlertDialogTitle>
            <AlertDialogDescription>{removalDescription(deleteTarget)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {deleteTarget ? removalVerb(deleteTarget) : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Flex>
  )
}
