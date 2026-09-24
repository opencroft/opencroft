'use client'

import { Code, Eye, List, Loader2, PanelRight, PanelRightClose } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'
import { PanelTabStrip } from 'ui/layouts/panel-tab-strip'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from 'ui/resizable'
import { BackButton } from 'ui/utils/back-button'

import {
  compileLocalExtension,
  deleteLocalExtensionFile,
  type LocalExtensionRecord,
  updateLocalExtension,
} from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'
import { CodePanel } from '@/app/_authed/(extension-editor)/_components/code-panel'
import { type ExtensionRecord, isInstalledRecord } from '@/app/_authed/(extension-editor)/_components/extension-detail'
import { ExtensionFileList, MANIFEST_PATH } from '@/app/_authed/(extension-editor)/_components/extension-file-list'
import { PreviewPanel } from '@/app/_authed/(extension-editor)/_components/preview-panel'
import { loadExtension } from '@/app/_authed/(extension-runtime)/_client/loader'
import type { CompileError, ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

/** How long the typing has to stop before the files are written and rebuilt.
 *  Long enough that a sentence is one build rather than forty. */
const AUTOSAVE_PAUSE_MS = 700

interface ExtensionSourceEditorProps {
  record: ExtensionRecord
  onBack: () => void
  /** A save landed: the list behind this editor is holding an older copy. */
  onSaved: (record: LocalExtensionRecord) => void
}

/** What this extension's files are, as one comparable string: paths and their
 *  contents, ordered, so "has anything changed since the last write" is one
 *  comparison rather than a walk. JSON rather than a delimiter, because any
 *  delimiter chosen here can also occur inside a file being edited. */
function fileSignature(files: Record<string, string>): string {
  return JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}

function firstEditablePath(files: Record<string, string>): string {
  const paths = Object.keys(files).sort()
  // The manifest opens only when it is all there is: an extension is read and
  // changed in its source, and the manifest is the file you go to on purpose.
  return paths.find((path) => path !== MANIFEST_PATH) ?? MANIFEST_PATH
}

// The extension editor, arranged like the design kit's source editor because
// it is the same work: one header naming what is open and the way back, then
// files, code and a live preview of what the code builds.
//
// Mount it keyed on the extension id — the buffer is initialised from the
// record it opens with, and a key is what makes switching extensions a fresh
// editor rather than a reconciliation between two sets of files.
export function ExtensionSourceEditor({ record, onBack, onSaved }: ExtensionSourceEditorProps) {
  // An installed extension is a checkout of somebody else's repository, kept in
  // step by reinstalling it. Editing it here would be overwritten by the next
  // update without warning, so its source is readable and not writable.
  const readOnly = isInstalledRecord(record)

  const [files, setFiles] = useState<Record<string, string>>(() => ({ ...record.files }))
  const [savedSignature, setSavedSignature] = useState(() => fileSignature(record.files))
  const [activePath, setActivePath] = useState(() => firstEditablePath(record.files))
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<CompileError[]>([])
  const [warnings, setWarnings] = useState<CompileError[]>([])
  const [previewTypeId, setPreviewTypeId] = useState<string | null>(null)
  const [previewVersion, setPreviewVersion] = useState(0)
  const [previewOpen, setPreviewOpen] = useState(true)
  const [tab, setTab] = useState<'files' | 'code' | 'preview'>('code')
  const lastAutoSignature = useRef<string>(fileSignature(record.files))

  const dirty = useMemo(() => fileSignature(files) !== savedSignature, [files, savedSignature])
  const extensionId = record.id

  // Rebuild what this instance is running, and point the preview at whatever
  // the build produced. Shared by the two things that move the files on disk —
  // a save and a file deletion — so a deleted file is not still in the bundle
  // until somebody happens to type again.
  const compileAndPreview = useCallback(
    async (manifest: ExtensionManifest) => {
      const result = await compileLocalExtension({ data: extensionId })
      setErrors(result.errors)
      setWarnings(result.warnings)
      if (!result.success) {
        return
      }
      const declaration = await loadExtension(manifest)
      const node = declaration?.nodes?.[0]
      if (node) {
        setPreviewTypeId(node.typeId)
        setPreviewVersion((version) => version + 1)
      }
    },
    [extensionId],
  )

  const persistAndCompile = useCallback(async () => {
    if (Object.keys(files).length === 0) {
      return
    }
    // A manifest mid-keystroke is not JSON, and writing it would flush the
    // loader's cache for a file it cannot parse. The next pause writes it.
    try {
      JSON.parse(files[MANIFEST_PATH] ?? '{}')
    } catch {
      return
    }
    const signature = fileSignature(files)
    if (signature === lastAutoSignature.current) {
      return
    }
    lastAutoSignature.current = signature
    setBusy(true)
    setErrors([])
    setWarnings([])
    try {
      const saved = await updateLocalExtension({ data: { extensionId, files } })
      setSavedSignature(fileSignature(saved.files))
      onSaved(saved)
      await compileAndPreview(saved.manifest)
    } catch (err) {
      console.error('[extensions] auto-compile failed', err)
    } finally {
      setBusy(false)
    }
  }, [extensionId, files, onSaved, compileAndPreview])

  useEffect(() => {
    if (readOnly || !dirty) {
      return
    }
    const timer = setTimeout(() => void persistAndCompile(), AUTOSAVE_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [readOnly, dirty, persistAndCompile])

  const handleChange = useCallback((path: string, value: string) => {
    setFiles((current) => ({ ...current, [path]: value }))
  }, [])

  const handleCreateFile = useCallback((path: string) => {
    setFiles((current) => (current[path] === undefined ? { ...current, [path]: '' } : current))
    setActivePath(path)
    setTab('code')
  }, [])

  // The file goes from the buffer and from the disk, in that order: the pane
  // answers the press immediately, and the write that makes it true follows.
  // Dropping it from the buffer alone is what the tab strip used to do, and
  // the file came back the next time the extension was opened.
  const handleDeleteFile = useCallback(
    async (path: string) => {
      setFiles((current) => {
        const next = { ...current }
        delete next[path]
        return next
      })
      setActivePath((current) => (current === path ? MANIFEST_PATH : current))
      if (readOnly) {
        return
      }
      setBusy(true)
      try {
        const saved = await deleteLocalExtensionFile({ data: { extensionId, path } })
        const signature = fileSignature(saved.files)
        setSavedSignature(signature)
        // What is on disk now, so the autosave does not immediately re-save an
        // identical set of files just because the buffer lost a key.
        lastAutoSignature.current = signature
        onSaved(saved)
        await compileAndPreview(saved.manifest)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [extensionId, readOnly, onSaved, compileAndPreview],
  )

  const paths = Object.keys(files)
  const content = files[activePath] ?? ''
  const language = activePath.endsWith('.json') ? 'json' : 'tsx'

  const filesPane = (
    <ExtensionFileList
      paths={paths}
      activePath={activePath}
      readOnly={readOnly}
      onSelect={(path) => {
        setActivePath(path)
        setTab('code')
      }}
      onCreate={handleCreateFile}
      onDelete={(path) => void handleDeleteFile(path)}
    />
  )

  const codePane = (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='flex shrink-0 items-center gap-2 border-b px-2 py-1.5'>
        <span className='min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground'>{activePath}</span>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='hidden size-6 shrink-0 lg:inline-flex'
          aria-label={previewOpen ? 'Hide the preview' : 'Show the preview'}
          title={previewOpen ? 'Hide the preview' : 'Show the preview'}
          onClick={() => setPreviewOpen((open) => !open)}
        >
          {previewOpen ? <PanelRightClose className='size-3.5' /> : <PanelRight className='size-3.5' />}
        </Button>
      </div>
      <div className='flex min-h-0 flex-1'>
        <CodePanel
          value={content}
          language={language}
          readOnly={readOnly}
          onChange={(value) => handleChange(activePath, value)}
        />
      </div>
    </div>
  )

  const previewPane = (
    <div className='flex h-full min-h-0 flex-col'>
      <div className='flex shrink-0 items-center gap-2 border-b px-2 py-1.5'>
        <span className='min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground'>Preview</span>
      </div>
      <div className='min-h-0 flex-1'>
        <PreviewPanel previewTypeId={previewTypeId} version={previewVersion} />
      </div>
    </div>
  )

  return (
    <div className='flex h-full min-h-0 w-full flex-col overflow-hidden'>
      <div className='flex w-full shrink-0 items-center gap-2 border-b px-2 py-1.5'>
        <BackButton label={`Back to ${record.manifest.name}`} onClick={onBack} />
        <div className='flex min-w-0 flex-1 flex-col overflow-hidden'>
          <span className='truncate text-sm leading-tight font-medium'>{record.manifest.name}</span>
          <span className='flex min-w-0 items-center gap-1 overflow-hidden text-xs leading-tight text-muted-foreground'>
            <span className='truncate font-mono'>{record.id}</span>
            {readOnly ? <span className='shrink-0'>· read-only</span> : null}
            {!readOnly && dirty ? <span className='shrink-0'>· unsaved</span> : null}
          </span>
        </div>
        {busy ? (
          <span className='flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground'>
            <Loader2 className='size-3.5 animate-spin' />
            Building
          </span>
        ) : null}
      </div>

      {/* Wide: three panes, two drag handles. */}
      <div className='hidden min-h-0 flex-1 lg:block'>
        <ResizablePanelGroup orientation='horizontal'>
          <ResizablePanel defaultSize='20%' minSize='150px'>
            {filesPane}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={previewOpen ? '50%' : '80%'} minSize='300px'>
            {codePane}
          </ResizablePanel>
          {previewOpen ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize='30%' minSize='150px'>
                {previewPane}
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </div>

      {/* Narrow: one pane at a time — a different arrangement, not a squeeze. */}
      <div className='flex min-h-0 flex-1 flex-col lg:hidden'>
        <PanelTabStrip
          tabs={[
            { id: 'files', label: 'Files', icon: List, count: paths.length },
            { id: 'code', label: 'Code', icon: Code },
            { id: 'preview', label: 'Preview', icon: Eye },
          ]}
          activeId={tab}
          onSelect={(id) => setTab(id as typeof tab)}
        />
        <div className='min-h-0 flex-1'>{tab === 'files' ? filesPane : tab === 'preview' ? previewPane : codePane}</div>
      </div>

      {/* Under every pane rather than inside the code one: a build reports on
          the extension, and at narrow widths a report placed in the code pane
          sits behind a tab where nobody would look for it. */}
      {errors.length > 0 ? (
        <div className='max-h-40 shrink-0 overflow-auto border-t border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-destructive'>
          {errors.map((error) => (
            <div key={`${error.file}:${error.line ?? '?'}:${error.message}`}>
              {error.file}:{error.line ?? '?'} {error.message}
            </div>
          ))}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className='max-h-24 shrink-0 overflow-auto border-t border-amber-500/40 bg-amber-500/10 px-3 py-2 font-mono text-xs whitespace-pre-wrap'>
          {warnings.map((warning) => (
            <div key={`${warning.file}:${warning.line ?? '?'}:${warning.message}`}>
              {warning.file}:{warning.line ?? '?'} {warning.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
