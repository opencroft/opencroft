'use client'

import { updateUser, useSession } from '@opencroft/auth/client'
import { isThemePreference, type ThemePreference } from '@opencroft/auth/theme'
import { useTheme } from 'next-themes'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

/**
 * Applies the signed-in person's stored theme when a page load first sees
 * their session, so the account's choice wins in every browser, including one
 * where a different choice was made. Within the page it is applied only that
 * once: a choice made here is applied locally at once and written back, so a
 * session refresh that lands late can never undo it.
 */
export function ThemePreferenceSync() {
  const { data: session } = useSession()
  const { setTheme } = useTheme()
  const appliedFor = useRef<string | null>(null)
  const userId = session?.user.id
  const stored = session?.user.theme

  useEffect(() => {
    if (!userId || appliedFor.current === userId) {
      return
    }
    appliedFor.current = userId
    if (isThemePreference(stored)) {
      setTheme(stored)
    }
  }, [userId, stored, setTheme])

  return null
}

function reportUnsaved(reason: string | undefined) {
  toast.error('Your theme could not be saved, so it will reset when the page reloads', { description: reason })
}

/** The theme in effect for this person, and the way to change it. */
export function useThemePreference(): { theme: ThemePreference; choose: (theme: ThemePreference) => void } {
  const { theme, setTheme } = useTheme()

  const choose = (next: ThemePreference) => {
    setTheme(next)
    updateUser({ theme: next }).then(
      ({ error }) => error && reportUnsaved(error.message),
      (error: unknown) => reportUnsaved(error instanceof Error ? error.message : undefined),
    )
  }

  return { theme: isThemePreference(theme) ? theme : 'system', choose }
}
