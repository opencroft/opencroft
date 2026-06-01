import { useCallback, useEffect, useRef } from 'react'

interface UseAutoScrollOptions {
  /** Threshold in pixels from bottom to consider "at bottom" */
  threshold?: number
}

export function useAutoScroll<T>(scrollRef: React.RefObject<HTMLDivElement | null>, dependencies: T[], options: UseAutoScrollOptions = {}) {
  const { threshold = 50 } = options
  const isAtBottomRef = useRef(true)
  const isInitialMount = useRef(true)

  const checkIfAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return true
    }
    const { scrollTop, scrollHeight, clientHeight } = el
    return scrollHeight - scrollTop - clientHeight <= threshold
  }, [scrollRef, threshold])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const el = scrollRef.current
      if (!el) {
        return
      }
      el.scrollTo({ top: el.scrollHeight, behavior })
    },
    [scrollRef],
  )

  // Track scroll position
  const handleScroll = useCallback(() => {
    isAtBottomRef.current = checkIfAtBottom()
  }, [checkIfAtBottom])

  // Initial scroll to bottom
  useEffect(() => {
    if (isInitialMount.current && dependencies.length > 0) {
      scrollToBottom('auto')
      isInitialMount.current = false
    }
  }, [dependencies.length, scrollToBottom])

  // Auto-scroll when dependencies change (if at bottom)
  useEffect(() => {
    if (!isInitialMount.current && isAtBottomRef.current) {
      scrollToBottom('smooth')
    }
  }, [dependencies, scrollToBottom])

  return {
    handleScroll,
    scrollToBottom,
    isAtBottom: () => isAtBottomRef.current,
  }
}
