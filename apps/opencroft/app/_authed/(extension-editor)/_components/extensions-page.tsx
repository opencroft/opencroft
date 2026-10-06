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
import { ExtensionUpdates } from 'ui/extensions/extension-updates'
import { Flex } from 'ui/layout/flex'
import { ScrollArea } from 'ui/layout/scroll-area'
import { TitleBarTitle, TitleBarToolbar } from 'ui/layouts/title-bar'
import { Spinner } from 'ui/spinner'

import {
  type ExtensionIndexEntry,
  listExtensionsIndex,
} from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import {
  getInstalledExtension,
  uninstallExtension,
} from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import {
  createLocalExtension,
  deleteLocalExtension,
  getLocalExtension,
  type LocalExtensionRecord,
} from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'
import { ExtensionDetail, type ExtensionRecord } from '@/app/_authed/(extension-editor)/_components/extension-detail'
import { ExtensionSourceEditor } from '@/app/_authed/(extension-editor)/_components/extension-source-editor'
import { ExtensionsListPanel } from '@/app/_authed/(extension-editor)/_components/extensions-list-panel'
import { ExtensionsToolbar } from '@/app/_authed/(extension-editor)/_components/extensions-toolbar'
import { InstallExtensionDialog } from '@/app/_authed/(extension-editor)/_components/install-extension-dialog'
import { RegistrySearchResults } from '@/app/_authed/(extension-editor)/_components/registry-search-results'
import type { UpdateAllSummary } from '@/app/_authed/(extension-editor)/_components/update-run'
import { useExtensionUpdates } from '@/app/_authed/(extension-editor)/_components/use-extension-updates'
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

function updateAllOutcome({ updated, current, failed, skipped }: UpdateAllSummary): string {
  return [
    `Updated ${updated}`,
    current > 0 ? `${current} already up to date` : null,
    failed > 0 ? `${failed} failed` : null,
    skipped > 0 ? `${skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(' · ')
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
// checkout, what it is running. Where each extension stands against its source
// is asked once the page is up, without holding the list back, and is what the
// toolbar's updates button counts and opens. Acts refresh the index rather than
// re-reading the world.
//
// The page's search and acts sit in the title bar's toolbar row. The search's
// results take the right pane while it has a query, and the box is emptied
// when the pane turns to something else, so it never stands over a pane that
// is not its results. The editor
// takes the whole surface when it opens, like the design kit's does: three
// panes need the room, and the way back is the header's own.
export default function ExtensionsPage({ index }: ExtensionsPageProps) {
  const router = useRouter()
  const [entries, setEntries] = useState<ExtensionIndexEntry[]>(index)
  const [query, setQuery] = useState('')
  const [showUpdates, setShowUpdates] = useState(false)
  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [selected, setSelected] = useState<ExtensionRecord | null>(null)
  // The folder whose record has been asked for and answered. A selection is
  // loading from the render it is made in until this catches up with it, so an
  // entry that cannot be opened is never shown for the frame before its load starts.
  const [loadedFolder, setLoadedFolder] = useState<string | null>(null)
  const selectedLoading = selectedFolder !== null && loadedFolder !== selectedFolder
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
    // Only this route's loader. Re-running the layouts' too would refetch the
    // whole chrome after every act, and any one of those requests failing
    // replaces the page with the router's error screen.
    void router.invalidate({ filter: (match) => match.routeId === '/_authed/(extension-editor)/extensions' })
    return next
  }, [router])

  // The open extension, with its files. Loaded per selection rather than with
  // the list, which is what keeps the list instant.
  const loadSelected = useCallback(async (folder: string): Promise<ExtensionRecord | null> => {
    return isLocalFolder(folder)
      ? await getLocalExtension({ data: folder })
      : await getInstalledExtension({ data: folder })
  }, [])

  // An update rewrote a folder: the index row follows it, and so does the open
  // page when it is that extension's.
  const selectedFolderRef = useRef(selectedFolder)
  selectedFolderRef.current = selectedFolder
  const afterUpdate = useCallback(
    async (folder: string) => {
      await refresh()
      if (selectedFolderRef.current === folder) {
        setSelected(await loadSelected(folder))
      }
    },
    [refresh, loadSelected],
  )
  const updates = useExtensionUpdates(entries, afterUpdate)
  const { checkFolder, update, updateAll } = updates

  useEffect(() => {
    if (!selectedFolder) {
      setSelected(null)
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

  // An opened checkout is asked again: it is the one extension on screen, and
  // its tree may have moved since the page's own check.
  useEffect(() => {
    if (selectedFolder && isLocalFolder(selectedFolder)) {
      void checkFolder(selectedFolder)
    }
  }, [selectedFolder, checkFolder])

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.folder === selectedFolder) ?? null,
    [entries, selectedFolder],
  )

  const handleSelect = useCallback((folder: string) => {
    setSelectedFolder(folder)
    setEditing(false)
    setShowUpdates(false)
    setQuery('')
  }, [])

  const handleQueryChange = useCallback((next: string) => {
    setQuery(next)
    if (next.trim()) {
      setSelectedFolder(null)
      setShowUpdates(false)
    }
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
            ? {
                ...entry,
                name: saved.manifest.name || entry.folder,
                version: saved.manifest.version,
                dirty: saved.sourceDirty === true ? true : undefined,
              }
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
      handleSelect(record.folder)
      // Straight into the editor: a template has nothing to read about yet,
      // and writing it is the only reason it was created.
      setEditing(true)
      toast.success(`Created ${record.manifest.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [localEntries, refresh, handleSelect])

  // An install landed in `folder`: the list is re-read and the new extension
  // opened, whatever kind of folder it went into.
  const handleInstalled = useCallback(
    async (folder: string) => {
      await refresh()
      handleSelect(folder)
      void checkFolder(folder)
    },
    [refresh, handleSelect, checkFolder],
  )

  const handleUpdate = useCallback(async () => {
    if (!selectedFolder) {
      return
    }
    setBusy(true)
    try {
      const result = await update(selectedFolder)
      if (result.ok) {
        toast.success(result.message)
      } else {
        toast.error(result.message)
      }
    } finally {
      setBusy(false)
    }
  }, [selectedFolder, update])

  const handleUpdateAll = useCallback(async () => {
    const summary = await updateAll()
    const outcome = updateAllOutcome(summary)
    if (summary.failed > 0) {
      toast.error(outcome)
    } else {
      toast.success(outcome)
    }
  }, [updateAll])

  // The updates list takes the pane an extension's page would: opening it
  // closes whatever extension was open.
  const openUpdates = useCallback(() => {
    setSelectedFolder(null)
    setEditing(false)
    setShowUpdates(true)
    setQuery('')
  }, [])

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
      <TitleBarTitle>Extensions</TitleBarTitle>
      <TitleBarToolbar>
        <ExtensionsToolbar
          query={query}
          onQueryChange={handleQueryChange}
          updatesAvailable={updates.available}
          onInstall={() => setInstallDialogOpen(true)}
          onNew={() => void handleNew()}
          onShowUpdates={openUpdates}
        />
      </TitleBarToolbar>
      <ExtensionsListPanel
        local={localEntries}
        installed={installedEntries}
        updateChecks={updates.installed}
        localStates={updates.local}
        selectedFolder={selectedFolder}
        onSelect={handleSelect}
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
          updateCheck={updates.installed[selected.folder]}
          remote={updates.local[selected.folder] ?? null}
          remoteChecking={updates.isChecking(selected.folder)}
          busy={busy || updates.running}
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
      ) : query.trim() ? (
        <ScrollArea className='min-w-0 flex-1'>
          <RegistrySearchResults
            className='mx-auto max-w-2xl px-6 py-6'
            query={query}
            installed={installedEntries}
            onInstalled={(folder) => void handleInstalled(folder)}
            onOpen={handleSelect}
          />
        </ScrollArea>
      ) : showUpdates ? (
        <ScrollArea className='min-w-0 flex-1'>
          <ExtensionUpdates
            className='mx-auto max-w-2xl px-6 py-6'
            updates={updates.overview.updates}
            blocked={updates.overview.blocked}
            checking={updates.checking}
            checkedLabel={
              updates.checkedAt ? `Checked at ${new Date(updates.checkedAt).toLocaleTimeString()}` : undefined
            }
            progress={updates.progress}
            onCheck={() => void updates.checkAll()}
            onUpdate={(folder) => void update(folder)}
            onUpdateAll={() => void handleUpdateAll()}
            onOpen={handleSelect}
          />
        </ScrollArea>
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
