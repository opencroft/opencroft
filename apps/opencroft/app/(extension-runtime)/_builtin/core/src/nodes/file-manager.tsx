import { InputHandle, icons, React, useNodeContext } from '@ext/host'

import { WindowShell } from '../shared'

interface WindowData {
  title: string
  connection?: Record<string, unknown>
}

export function FileManagerWindowNode({ id, data, selected }: { id: string; data: WindowData; selected?: boolean }) {
  const ctx = useNodeContext<unknown>(id, 'fs-in')
  return (
    <WindowShell
      id={id}
      selected={selected}
      icon={icons.FolderOpen}
      iconClassName='text-amber-400'
      title={data.title || 'File Manager'}
      bodyClassName='bg-card'
      input={
        <InputHandle type='filesystem-target' id='fs-in'>
          <span className='text-[10px] text-muted-foreground'>Files</span>
        </InputHandle>
      }
    >
      {ctx || data.connection ? (
        <div className='text-[11px] text-muted-foreground italic p-2'>
          File browser body lands next (SFTP / WSL / local storage adapters).
        </div>
      ) : (
        <div className='text-[11px] text-muted-foreground italic p-2'>Connect a filesystem target to this window.</div>
      )}
    </WindowShell>
  )
}

export function FileManagerWindowInspector() {
  return (
    <div className='text-xs text-muted-foreground'>
      <p>The file manager window node is currently a placeholder.</p>
      <p className='mt-2'>
        Phase 1b will wire this to the existing
        <code> /app/(filemanager) </code> storage adapters.
      </p>
    </div>
  )
}
