import { useEffect, useRef, useState } from 'react'

export interface UseTimerOptions {
  delay: number
  onTimeout: () => void
  enabled?: boolean
}

export function useTimer({ delay, onTimeout, enabled = true }: UseTimerOptions) {
  const [isActive, setIsActive] = useState(false)
  const [remainingTime, setRemainingTime] = useState(0)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)
  const startTimeRef = useRef<number>(0)

  const stop = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    setIsActive(false)
    setRemainingTime(0)
  }

  const start = () => {
    stop()
    if (!enabled) {
      return
    }

    setIsActive(true)
    startTimeRef.current = Date.now()
    setRemainingTime(delay)

    timerRef.current = setTimeout(() => {
      onTimeout()
      setIsActive(false)
      setRemainingTime(0)
    }, delay)

    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current
      const remaining = Math.max(0, delay - elapsed)
      setRemainingTime(remaining)

      if (remaining === 0) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
      }
    }, 100)
  }

  const restart = (activate = false) => {
    if (!isActive && !activate) {
      return
    }
    start()
  }

  useEffect(() => {
    if (!enabled) {
      stop()
    }
  }, [enabled])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [])

  return {
    isActive,
    remainingTime,
    start,
    stop,
    restart,
  }
}
