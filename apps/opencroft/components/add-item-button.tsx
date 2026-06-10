'use client'

import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from 'ui/dialog'
import { Input } from 'ui/input'
import { Label } from 'ui/label'
import { ControlledTextarea } from '@/components/ui/input/controlled-textarea'
import type { BasePrompt } from '@/lib/ai-utils'

interface AddItemButtonProps {
  buttonText: string
  placeholder: string
  onAdd: (name: string, data: BasePrompt) => Promise<void>
}

export function AddItemButton({ buttonText, placeholder, onAdd }: AddItemButtonProps) {
  const [itemName, setItemName] = useState('')
  const [positivePrompt, setPositivePrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [open, setOpen] = useState(false)

  const handleAdd = async () => {
    if (!itemName.trim()) {
      return
    }
    const data: BasePrompt = {
      positive_prompt: positivePrompt.trim(),
      negative_prompt: negativePrompt.trim(),
    }
    await onAdd(itemName.trim(), data)
    setItemName('')
    setPositivePrompt('')
    setNegativePrompt('')
    setOpen(false)
  }

  const handleCancel = () => {
    setItemName('')
    setPositivePrompt('')
    setNegativePrompt('')
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size='icon' title={buttonText} variant={'outline'}>
          <Plus className='h-4 w-4' />
        </Button>
      </DialogTrigger>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Add New Item</DialogTitle>
          <DialogDescription>Enter a name and prompts for the new item.</DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 py-4'>
          <div className='grid gap-2'>
            <Label htmlFor='name'>Name</Label>
            <Input
              id='name'
              placeholder={placeholder}
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  handleCancel()
                }
              }}
              autoFocus
            />
          </div>
          <div className='grid gap-2'>
            <Label htmlFor='positive'>Positive Prompt</Label>
            <ControlledTextarea id='positive' value={positivePrompt} onValueChanged={(value) => setPositivePrompt(value)} placeholder='Positive prompt...' rows={4} className='font-mono' />
          </div>
          <div className='grid gap-2'>
            <Label htmlFor='negative'>Negative Prompt</Label>
            <ControlledTextarea id='negative' value={negativePrompt} onValueChanged={(value) => setNegativePrompt(value)} placeholder='Negative prompt...' rows={3} className='font-mono' />
          </div>
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!itemName.trim()}>
            <Plus className='h-4 w-4 mr-2' />
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
