import { useEffect } from 'react'

type KeyHandler = () => void

export function useShortcut(key: string, handler: KeyHandler, enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) {
      return
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === key) {
        handler()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [key, handler, enabled])
}
