import { useCallback, useEffect, useRef } from 'react'

export function useDebounce(callback: (value: string) => void, delay: number) {
  const timer = useRef<NodeJS.Timeout | undefined>(undefined)
  const pending = useRef<{ value: string } | undefined>(undefined)
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
    pending.current = undefined
  }, [])

  /** Runs the pending call now instead of when the delay ends; no-op when nothing is pending. */
  const flush = useCallback(() => {
    const call = pending.current
    cancel()
    if (call) {
      callbackRef.current(call.value)
    }
  }, [cancel])

  const debouncedFn = useCallback(
    (value: string) => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
      pending.current = { value }
      timer.current = setTimeout(flush, delay)
    },
    [delay, flush],
  )

  return Object.assign(debouncedFn, { cancel, flush })
}
