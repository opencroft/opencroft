'use client'

import { useCallback, useEffect, useState } from 'react'

function readStorage<T>(key: string, fallback: T): T {
  const item = window.localStorage.getItem(key)
  if (!item || item === '""' || item === 'undefined') {
    return fallback
  }
  return JSON.parse(item)
}

export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(initialValue)

  useEffect(() => {
    setStoredValue(readStorage(key, initialValue))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Stable per key, and an updater sees the current value rather than the one
  // from the render the setter came from. The write sits inside the updater so
  // it stores exactly what the state becomes; running twice (strict mode)
  // writes the same value twice.
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const valueToStore = value instanceof Function ? value(prev) : value
        window.localStorage.setItem(key, JSON.stringify(valueToStore))
        return valueToStore
      })
    },
    [key],
  )

  return [storedValue, setValue]
}
