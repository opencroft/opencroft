import { Plus } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ControlledInput } from '@/components/ui/input/controlled-input'

interface AddItemProps {
  buttonText: string
  placeholder: string
  onAdd: (name: string) => void
}

export function AddItemInput({ buttonText, placeholder, onAdd }: AddItemProps) {
  const [itemName, setItemName] = useState('')

  const handleAdd = () => {
    if (!itemName.trim()) {
      return
    }
    onAdd(itemName.trim())
    setItemName('')
  }

  return (
    <div className='flex gap-2'>
      <ControlledInput placeholder={placeholder} value={itemName} onValueChanged={(value) => setItemName(value)} onAccepted={handleAdd} />
      <Button onClick={handleAdd} disabled={!itemName.trim()}>
        <Plus className='h-4 w-4 mr-2' />
        {buttonText}
      </Button>
    </div>
  )
}
