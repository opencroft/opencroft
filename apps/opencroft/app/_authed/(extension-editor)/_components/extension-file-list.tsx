'use client'

import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from 'ui/button'
import { Input } from 'ui/input'
import { RowContextMenu } from 'ui/utils/row-context-menu'

import { cn } from '@/lib/utils'

export const MANIFEST_PATH = 'extension.json'

interface ExtensionFileListProps {
  paths: string[]
  activePath: string
  readOnly?: boolean
  onSelect: (path: string) => void
  onCreate: (path: string) => void
  onDelete: (path: string) => void
}

function sortPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    // The manifest is the file every extension has and the one every reader
    // looks for first, so it leads rather than falling wherever "e" sorts.
    if (a === MANIFEST_PATH) {
      return -1
    }
    if (b === MANIFEST_PATH) {
      return 1
    }
    return a.localeCompare(b)
  })
}

function PathInput({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('src/')
  return (
    <Input
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      className='h-7 font-mono text-xs'
      onChange={(event) => setValue(event.target.value)}
      onBlur={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && value.trim()) {
          onSubmit(value.trim())
        }
        if (event.key === 'Escape') {
          onCancel()
        }
      }}
    />
  )
}

// One extension's files, as a pane rather than a tab strip: the same shape the
// design kit's source editor uses, because they are the same job — a list of
// paths to move between, with new and delete on the list itself.
//
// Delete answers IN the row. The file goes back with the next edit to it and
// nothing is published by removing it here, so a modal would claim an
// irreversibility this does not have — and the confirmation names the file,
// which a modal opened from a row has to repeat anyway.
export function ExtensionFileList({
  paths,
  activePath,
  readOnly = false,
  onSelect,
  onCreate,
  onDelete,
}: ExtensionFileListProps) {
  const [creating, setCreating] = useState(false)
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null)

  return (
    <div className='flex h-full min-h-0 w-full flex-col'>
      <div className='flex shrink-0 items-center gap-2 border-b px-2 py-1.5'>
        <span className='min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground'>Files</span>
        {readOnly ? null : (
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-6 shrink-0'
            aria-label='New file'
            title='New file'
            onClick={() => setCreating(true)}
          >
            <Plus className='size-3.5' />
          </Button>
        )}
      </div>

      <div className='min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1'>
        {creating ? (
          <div className='px-1 py-1'>
            <PathInput
              placeholder='File path'
              onSubmit={(path) => {
                setCreating(false)
                onCreate(path)
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        ) : null}

        {sortPaths(paths).map((path) => {
          if (path === pendingDeletePath) {
            return (
              <div key={path} className='rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5'>
                <p className='text-xs font-medium text-destructive'>Delete this file?</p>
                <p className='truncate pt-0.5 font-mono text-xs text-destructive'>{path}</p>
                <div className='flex items-center gap-1 pt-1.5'>
                  <Button
                    type='button'
                    size='sm'
                    variant='destructive'
                    className='h-6 px-2 text-xs'
                    onClick={() => {
                      setPendingDeletePath(null)
                      onDelete(path)
                    }}
                  >
                    Delete
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    className='h-6 px-2 text-xs'
                    onClick={() => setPendingDeletePath(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )
          }

          const active = path === activePath
          // The manifest is what the extension IS — deleting it leaves a
          // directory the loader cannot read — so that row carries no menu.
          const deletable = !readOnly && path !== MANIFEST_PATH
          return (
            <RowContextMenu key={path} onDelete={deletable ? () => setPendingDeletePath(path) : undefined}>
              <button
                type='button'
                onClick={() => onSelect(path)}
                title={path}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-xs transition-colors',
                  active
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <span className='min-w-0 flex-1 truncate'>{path}</span>
              </button>
            </RowContextMenu>
          )
        })}
      </div>
    </div>
  )
}
