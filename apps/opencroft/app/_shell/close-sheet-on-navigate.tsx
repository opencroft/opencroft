'use client'

import { useLocation } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { useSidebar } from 'ui/sidebar'

/**
 * Closes the phone sheet of the surrounding sidebar when `at` changes, and
 * leaves it as it is while `at` holds.
 */
export function useCloseSheetOnChange(at: string): void {
  const { setOpenMobile } = useSidebar()
  const last = useRef(at)

  useEffect(() => {
    if (last.current !== at) {
      last.current = at
      setOpenMobile(false)
    }
  }, [at, setOpenMobile])
}

/**
 * On a phone the main sidebar is a sheet over the page. Any move to another
 * address closes it, whoever made the move: a link in the sheet (an App's own
 * pages among them), the title bar, or Back. Nothing inside an App can close
 * the host's sheet, so the host does it for every App. A leaf of its own, so
 * only it re-renders as the address changes.
 */
export function CloseSheetOnNavigate() {
  useCloseSheetOnChange(useLocation({ select: (location) => location.href }))
  return null
}
