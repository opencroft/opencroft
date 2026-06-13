'use client'

import { Loader2 } from 'lucide-react'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from 'ui/resizable'

import { CodePanel } from '@/app/(extension-editor)/_components/code-panel'
import { type EditorFile, FileTabs, fileLanguage } from '@/app/(extension-editor)/_components/file-tabs'
import { PreviewPanel } from '@/app/(extension-editor)/_components/preview-panel'
import type { CompileError } from '@/app/(extension-runtime)/_types'

interface ExtensionWorkspaceProps {
  title: string
  files: Record<string, string>
  activeFile: EditorFile
  busy: boolean
  errors: CompileError[]
  warnings: CompileError[]
  previewTypeId: string | null
  previewVersion: number
  onFileSelect: (file: EditorFile) => void
  onCreateFile: (filePath: string) => void
  onDeleteFile: (filePath: string) => void
  onChange: (file: EditorFile, value: string) => void
}

export function ExtensionWorkspace({
  title,
  files,
  activeFile,
  busy,
  errors,
  warnings,
  previewTypeId,
  previewVersion,
  onFileSelect,
  onCreateFile,
  onDeleteFile,
  onChange,
}: ExtensionWorkspaceProps) {
  const content = files[activeFile] ?? ''
  const language = fileLanguage(activeFile) as 'tsx' | 'json'

  return (
    <div className='flex-1 min-w-0 flex flex-col'>
      <div className='flex items-center gap-2 px-4 pt-3 pb-2'>
        <span className='text-sm font-semibold flex-1 truncate'>{title}</span>
        {busy ? <Loader2 className='size-3.5 animate-spin text-muted-foreground' /> : null}
      </div>
      <FileTabs
        files={files}
        active={activeFile}
        onSelect={onFileSelect}
        onCreate={onCreateFile}
        onDelete={onDeleteFile}
      />
      <div className='flex-1 min-h-0 flex'>
        <ResizablePanelGroup orientation='horizontal'>
          <ResizablePanel defaultSize={65} minSize={30}>
            <div className='h-full w-full flex'>
              <CodePanel value={content} language={language} onChange={(v) => onChange(activeFile, v)} />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={35} minSize={15}>
            <PreviewPanel previewTypeId={previewTypeId} version={previewVersion} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      {errors.length > 0 ? (
        <div className='mx-4 mb-3 text-xs font-mono p-2 border border-destructive/50 bg-destructive/10 rounded-sm whitespace-pre-wrap max-h-40 overflow-auto shrink-0 text-destructive'>
          {errors.map((e, i) => (
            <div key={i}>
              {e.file}:{e.line ?? '?'} {e.message}
            </div>
          ))}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className='mx-4 mb-3 text-xs font-mono p-2 border border-amber-500/50 bg-amber-500/10 rounded-sm whitespace-pre-wrap max-h-24 overflow-auto shrink-0'>
          {warnings.map((w, i) => (
            <div key={i}>
              {w.file}:{w.line ?? '?'} {w.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
