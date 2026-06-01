import { useState } from 'react'

import { Button } from '@/components/ui/button'

interface SaveButtonProps {
  saveConfig: () => Promise<void>
  text?: string
}

export function SaveButton({ saveConfig, text = 'Save' }: SaveButtonProps) {
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveConfig()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='flex justify-end'>
      <Button onClick={handleSave} disabled={saving} className='min-w-[120px]'>
        {saving ? 'Saving...' : text}
      </Button>
    </div>
  )
}
