import { FileBrowser, FileManagerProvider } from '@opencroft/client/files'
import { Button } from '@opencroft/client/ui'
import type { ComponentType, ReactNode } from 'react'

// ═════════════════════════════════════════════════════════════════════
// Handle definitions
// ═════════════════════════════════════════════════════════════════════

export type HandleDef = {
  id: string
  handleType: string
  role: 'source' | 'target'
  label?: string
  dynamic?: boolean
  multiple?: boolean
}

export const TERMINAL_SOURCE: HandleDef[] = [
  { id: 'terminal', handleType: 'terminal-context', role: 'source', label: 'Terminal' },
]

export const TERMINAL_CONSUMER: HandleDef[] = [
  { id: 'ssh-in', handleType: 'terminal-context', role: 'target', label: 'Terminal' },
]

export const SCRIPT_CONSUMER: HandleDef[] = [
  { id: 'ctx-in', handleType: 'terminal-context', role: 'target', label: 'Target' },
  // A handler serves every trigger wired into it: dispatch starts at the trigger.
  { id: 'exec-in', handleType: 'execution-context', role: 'target', label: 'Handler', multiple: true },
  { id: 'stdout-out', handleType: 'text-stream', role: 'source', label: 'Output' },
]

// ═════════════════════════════════════════════════════════════════════
// PinButton
// ═════════════════════════════════════════════════════════════════════

interface PinButtonProps {
  icon: ComponentType<{ className?: string }>
  label: string
  onClick?: () => void
}

export function PinButton({ icon: Icon, label, onClick }: PinButtonProps) {
  return (
    <Button variant='ghost' size='sm' className='nodrag nopan h-5 text-[10px] px-1.5' onClick={onClick}>
      <Icon className='h-2.5 w-2.5 shrink-0' />
      <span className='truncate'>{label}</span>
    </Button>
  )
}

// ═════════════════════════════════════════════════════════════════════
// StatsList & PinnedBody
// ═════════════════════════════════════════════════════════════════════

export function StatsList({ items }: { items: { icon: ComponentType<{ className?: string }>; value: string }[] }) {
  return (
    <div className='flex flex-col gap-0.5'>
      {items.map((item) => (
        <div key={item.value} className='flex items-center gap-1.5 text-[10px]'>
          <item.icon className='h-2.5 w-2.5 text-muted-foreground shrink-0' />
          <span className='text-muted-foreground truncate'>{item.value}</span>
        </div>
      ))}
    </div>
  )
}

export function PinnedBody({ input, output }: { input?: ReactNode; output?: ReactNode }) {
  return (
    <div className='flex justify-between gap-2'>
      {input ? <div className='flex-1 min-w-0'>{input}</div> : null}
      {output ? <div className='flex flex-col gap-0.5'>{output}</div> : null}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════
// InspectorFilesBody — embeddable file browser for inspector tabs
// ═════════════════════════════════════════════════════════════════════

interface StorageConnection {
  id: string
  name: string
  type: 's3' | 'ssh' | 'wsl' | 'docker'
  config: Record<string, unknown>
}

export function InspectorFilesBody({ connection }: { connection: StorageConnection }) {
  return (
    <FileManagerProvider initialConnection={connection}>
      <FileBrowser />
    </FileManagerProvider>
  )
}
