'use client'

import { FileUp, Plus } from 'lucide-react'
import { useRef, useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { Input } from 'ui/components/ui/input'

interface AddImportFooterProps {
  onAdd: (name: string) => Promise<void> | void
  onImport: (file: File) => Promise<void> | void
  placeholder?: string
  accept?: string
}

export function AddImportFooter({ onAdd, onImport, placeholder = 'Name...', accept = '.json' }: AddImportFooterProps) {
  const [name, setName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleAdd() {
    const trimmed = name.trim()
    if (!trimmed) return
    await onAdd(trimmed)
    setName('')
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type='file'
        accept={accept}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) {
            onImport(file)
            e.target.value = ''
          }
        }}
        className='hidden'
      />
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleAdd()
        }}
        placeholder={placeholder}
        className='flex-1'
      />
      <Button size='icon' onClick={handleAdd} disabled={!name.trim()}>
        <Plus className='h-4 w-4' />
      </Button>
      <Button size='icon' variant='outline' onClick={() => fileInputRef.current?.click()}>
        <FileUp className='h-4 w-4' />
      </Button>
    </>
  )
}
