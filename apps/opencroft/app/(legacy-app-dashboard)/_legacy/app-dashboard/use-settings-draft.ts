import { useCallback, useEffect, useState } from 'react'

import type { NodeSettingsProps } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'

export function useSettingsDraft<T extends Record<string, unknown>>(
  { id, data, updateData, onDirtyChange, onLoadingChange }: NodeSettingsProps<T>,
  onSave?: (draft: T) => void | Promise<void>,
) {
  const [draft, setDraft] = useState<T>(data as T)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDraft(data as T)
    setDirty(false)
    onLoadingChange(false)
  }, [id])

  const update = useCallback((partial: Partial<T>) => {
    setDraft((prev) => ({ ...prev, ...partial }))
    setDirty(true)
  }, [])

  useEffect(() => {
    onDirtyChange(dirty, async () => {
      await onSave?.(draft)
      updateData(draft)
      setDirty(false)
    })
  }, [dirty, draft, updateData, onSave, onDirtyChange])

  return { draft, update }
}
