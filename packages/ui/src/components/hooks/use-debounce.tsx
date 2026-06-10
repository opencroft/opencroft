import { useCallback, useEffect, useRef } from 'react'

export function useDebounce(callback: (value: string) => void, delay: number) {
  const timer = useRef<NodeJS.Timeout | undefined>(undefined)
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [])

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
  }, [])

  const debouncedFn = useCallback(
    (value: string) => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
      timer.current = setTimeout(() => {
        callbackRef.current(value)
      }, delay)
    },
    [delay],
  )

  return Object.assign(debouncedFn, { cancel })
}
