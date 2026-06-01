'use client'

import { useEffect, useState } from 'react'

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

  const setValue = (value: T | ((prev: T) => T)) => {
    const valueToStore = value instanceof Function ? value(storedValue) : value
    setStoredValue(valueToStore)
    window.localStorage.setItem(key, JSON.stringify(valueToStore))
  }

  return [storedValue, setValue]
}
