import { useCallback, useEffect, useState } from 'react'

import type { NodeSettingsProps } from '@/app/_authed/(legacy-app-dashboard)/_legacy/app-dashboard/registry'

export function useSettingsDraft<T extends Record<string, unknown>>(
  { id, data, updateData, onDirtyChange, onLoadingChange }: NodeSettingsProps<T>,
  onSave?: (draft: T) => void | Promise<void>,
) {
  const [draft, setDraft] = useState<T>(data as T)
  const [dirty, setDirty] = useState(false)

  // Resets the draft only when another node is opened. `data` changes on every
  // save; resetting on that would throw away what the user is typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `data` is left out on purpose, see above
  useEffect(() => {
    setDraft(data as T)
    setDirty(false)
    onLoadingChange(false)
  }, [id, onLoadingChange])

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
