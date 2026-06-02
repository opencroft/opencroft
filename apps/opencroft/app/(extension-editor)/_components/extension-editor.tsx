'use client'

import { ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import {
  checkInstalledForUpdates,
  type InstalledExtensionRecord,
  listInstalledExtensions,
  type UpdateCheck,
  uninstallExtension,
  updateInstalledExtension,
} from '@/app/(extension-editor)/_actions/installed-extensions-actions'
import {
  compileLocalExtension,
  createLocalExtension,
  deleteLocalExtension,
  type LocalExtensionRecord,
  listLocalExtensions,
  updateLocalExtension,
} from '@/app/(extension-editor)/_actions/local-extensions-actions'
import { ExtensionWorkspace } from '@/app/(extension-editor)/_components/extension-workspace'
import { ExtensionsListPanel } from '@/app/(extension-editor)/_components/extensions-list-panel'
import { InstallExtensionDialog } from '@/app/(extension-editor)/_components/install-extension-dialog'
import { extensionTemplate } from '@/app/(extension-editor)/_templates/template'
import { loadExtension } from '@/app/(extension-runtime)/_client/loader'
import type { CompileError } from '@/app/(extension-runtime)/_types'
import { Button } from '@opencroft/ui-kit/button'

function recordSignature(files: Record<string, string>): string {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}\n${v}`)
    .join('\n\u0000\n')
}

function pickUntitledSlug(existing: LocalExtensionRecord[]): string {
  const taken = new Set(existing.map((r) => r.slug))
  let i = 1
  while (taken.has(i === 1 ? 'untitled' : `untitled-${i}`)) {
    i += 1
  }
  return i === 1 ? 'untitled' : `untitled-${i}`
}

interface ExtensionEditorProps {
  initialExtensionId: string | null
  onBack: () => void
  onExtensionChanged: () => void
}

export function ExtensionEditor({ initialExtensionId, onBack, onExtensionChanged }: ExtensionEditorProps) {
  const [records, setRecords] = useState<LocalExtensionRecord[]>([])
  const [installed, setInstalled] = useState<InstalledExtensionRecord[]>([])
  const [updateChecks, setUpdateChecks] = useState<Record<string, UpdateCheck>>({})
  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(initialExtensionId)
  const [files, setFiles] = useState<Record<string, string>>({})
  const [savedSignature, setSavedSignature] = useState<string>('')
  const [activeFile, setActiveFile] = useState<string>('extension.json')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<CompileError[]>([])
  const [warnings, setWarnings] = useState<CompileError[]>([])
  const [previewTypeId, setPreviewTypeId] = useState<string | null>(null)
  const [previewVersion, setPreviewVersion] = useState(0)
  const autoPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoSignature = useRef<string>('')

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

  const selected = useMemo(() => records.find((r) => r.id === selectedId) ?? installed.find((r) => r.id === selectedId) ?? null, [records, installed, selectedId])

  // Load files when selection changes
  useEffect(() => {
    setPreviewTypeId(null)
    if (selected) {
      setFiles({ ...selected.files })
      setSavedSignature(recordSignature(selected.files))
      setErrors([])
      setWarnings([])
      // Default to first non-manifest file, or manifest if no other files
      const fileKeys = Object.keys(selected.files).sort()
      const firstNonManifest = fileKeys.find((f) => f !== 'extension.json')
      setActiveFile(firstNonManifest ?? 'extension.json')
    } else {
      setFiles({})
      setActiveFile('extension.json')
    }
  }, [selectedId, selected])

  const dirty = useMemo(() => {
    return recordSignature(files) !== savedSignature
  }, [files, savedSignature])

  const autoPersistAndCompile = useCallback(async () => {
    if (!selectedId || Object.keys(files).length === 0) {
      return
    }
    if (selectedId.startsWith('installed/')) {
      return
    }
    // Validate manifest JSON
    try {
      JSON.parse(files['extension.json'] ?? '{}')
    } catch {
      return
    }
    const signature = recordSignature(files)
    if (signature === lastAutoSignature.current) {
      return
    }
    lastAutoSignature.current = signature
    setBusy(true)
    setErrors([])
    setWarnings([])
    try {
      const record = await updateLocalExtension({ data: { extensionId: selectedId, files } })
      setSavedSignature(recordSignature(record.files))
      setRecords((prev) => prev.map((r) => (r.id === record.id ? record : r)))
      const result = await compileLocalExtension({ data: selectedId })
      setErrors(result.errors)
      setWarnings(result.warnings)
      if (result.success) {
        const decl = await loadExtension(record.manifest)
        if (decl && decl.nodes && decl.nodes[0]) {
          setPreviewTypeId(decl.nodes[0].typeId)
          setPreviewVersion((v) => v + 1)
        }
        onExtensionChanged()
      }
    } catch (err) {
      console.error('[editor] auto-compile failed', err)
    } finally {
      setBusy(false)
    }
  }, [files, selectedId, onExtensionChanged])

  useEffect(() => {
    if (!dirty || Object.keys(files).length === 0 || !selectedId) {
      return
    }
    if (autoPersistTimer.current) {
      clearTimeout(autoPersistTimer.current)
    }
    autoPersistTimer.current = setTimeout(() => {
      autoPersistAndCompile()
    }, 700)
    return () => {
      if (autoPersistTimer.current) {
        clearTimeout(autoPersistTimer.current)
      }
    }
  }, [dirty, files, selectedId, autoPersistAndCompile])

  useEffect(() => {
    lastAutoSignature.current = savedSignature
  }, [selectedId, savedSignature])

  const handleChange = useCallback((file: string, value: string) => {
    setFiles((prev) => ({ ...prev, [file]: value }))
  }, [])

  const handleCreateFile = useCallback((filePath: string) => {
    setFiles((prev) => ({ ...prev, [filePath]: '' }))
    setActiveFile(filePath)
  }, [])

  const handleDeleteFile = useCallback(
    (filePath: string) => {
      setFiles((prev) => {
        const next = { ...prev }
        delete next[filePath]
        return next
      })
      // If deleting active file, switch to another
      setActiveFile((current) => {
        if (current === filePath) {
          const remaining = Object.keys(files).filter((f) => f !== filePath)
          return remaining[0] ?? 'extension.json'
        }
        return current
      })
    },
    [files],
  )

  const handleNew = useCallback(async () => {
    setBusy(true)
    try {
      const list = await listLocalExtensions()
      const slug = pickUntitledSlug(list)
      const templateFiles = extensionTemplate(slug)
      const record = await createLocalExtension({ data: templateFiles })
      await refresh()
      setSelectedId(record.id)
      onExtensionChanged()
      toast.success(`Created ${record.manifest.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [refresh, onExtensionChanged])

  const handleDelete = useCallback(
    async (extensionId: string) => {
      const record = records.find((r) => r.id === extensionId)
      if (!confirm(`Delete ${record?.manifest.name ?? extensionId}?`)) {
        return
      }
      setBusy(true)
      try {
        await deleteLocalExtension({ data: extensionId })
        await refresh()
        if (selectedId === extensionId) {
          setSelectedId(null)
          setFiles({})
        }
        onExtensionChanged()
        toast.success('Extension deleted')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [records, selectedId, refresh, onExtensionChanged],
  )

  const handleInstalled = useCallback(
    async (record: InstalledExtensionRecord) => {
      const { installed: list } = await refresh()
      setSelectedId(record.id)
      onExtensionChanged()
      checkAllUpdates(list)
    },
    [refresh, onExtensionChanged, checkAllUpdates],
  )

  const handleUpdate = useCallback(
    async (extensionId: string) => {
      const check = updateChecks[extensionId]
      setBusy(true)
      try {
        const record = await updateInstalledExtension({ data: { extensionId, ref: check?.latest ?? undefined } })
        const { installed: list } = await refresh()
        checkAllUpdates(list)
        onExtensionChanged()
        toast.success(`Updated ${record.manifest.name ?? record.id} to ${record.sidecar.ref}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [updateChecks, refresh, checkAllUpdates, onExtensionChanged],
  )

  const handleUninstall = useCallback(
    async (extensionId: string) => {
      const record = installed.find((r) => r.id === extensionId)
      if (!confirm(`Uninstall ${record?.manifest.name ?? extensionId}?`)) {
        return
      }
      setBusy(true)
      try {
        await uninstallExtension({ data: extensionId })
        const { installed: list } = await refresh()
        if (selectedId === extensionId) {
          setSelectedId(null)
          setFiles({})
        }
        checkAllUpdates(list)
        onExtensionChanged()
        toast.success('Extension uninstalled')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [installed, selectedId, refresh, checkAllUpdates, onExtensionChanged],
  )

  const title = selected ? `${selected.manifest.name} · ${selected.id}` : 'Select a local extension'

  return (
    <div className='flex h-full w-full flex-col'>
      <div className='flex items-center gap-2 p-3 border-b'>
        <Button variant='ghost' size='sm' onClick={onBack}>
          <ArrowLeft className='size-3.5 mr-1' />
          Back to graph
        </Button>
        <span className='text-sm font-semibold'>Extensions</span>
      </div>
      <div className='flex-1 min-h-0 flex'>
        <ExtensionsListPanel
          records={records}
          installed={installed}
          updateChecks={updateChecks}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onNew={handleNew}
          onInstall={() => setInstallDialogOpen(true)}
          onDelete={handleDelete}
          onUpdate={handleUpdate}
          onUninstall={handleUninstall}
        />
        <InstallExtensionDialog open={installDialogOpen} onOpenChange={setInstallDialogOpen} onInstalled={handleInstalled} />
        {selectedId && Object.keys(files).length > 0 ? (
          <ExtensionWorkspace
            title={title}
            files={files}
            activeFile={activeFile}
            busy={busy}
            errors={errors}
            warnings={warnings}
            previewTypeId={previewTypeId}
            previewVersion={previewVersion}
            onFileSelect={setActiveFile}
            onCreateFile={handleCreateFile}
            onDeleteFile={handleDeleteFile}
            onChange={handleChange}
          />
        ) : (
          <div className='flex-1 flex items-center justify-center text-sm text-muted-foreground'>Select a local extension from the list, or click + to create a new one.</div>
        )}
      </div>
    </div>
  )
}
