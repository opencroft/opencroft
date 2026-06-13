import { useCallback, useEffect, useRef } from 'react'

interface UseAutoScrollOptions {
  /** Threshold in pixels from bottom to consider "at bottom" */
  threshold?: number
}

export function useAutoScroll<T>(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  dependencies: T[],
  options: UseAutoScrollOptions = {},
) {
  const { threshold = 50 } = options
  // Whether the view is "pinned" to the bottom and should follow new content.
  const pinnedRef = useRef(true)
  const isInitialMount = useRef(true)
  // Set while we programmatically scroll, so our own scroll events don't get
  // mistaken for the user moving away from the bottom.
  const programmaticRef = useRef(false)

  const checkIfAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    const { scrollTop, scrollHeight, clientHeight } = el
    return scrollHeight - scrollTop - clientHeight <= threshold
  }, [scrollRef, threshold])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const el = scrollRef.current
      if (!el) return
      programmaticRef.current = true
      el.scrollTo({ top: el.scrollHeight, behavior })
      // Release the guard once the resulting scroll event has settled.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          programmaticRef.current = false
        })
      })
    },
    [scrollRef],
  )

  // Track scroll position (ignoring our own programmatic scrolls).
  const handleScroll = useCallback(() => {
    if (programmaticRef.current) return
    pinnedRef.current = checkIfAtBottom()
  }, [checkIfAtBottom])

  // A user gesture toward the top unpins immediately, so streaming content can't
  // yank the view back down (and fight the scroll) while they're reading up.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) pinnedRef.current = false
    }
    let lastTouchY = 0
    const onTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? 0
      // Finger moving down drags the content down = scrolling toward the top.
      if (y > lastTouchY) pinnedRef.current = false
      lastTouchY = y
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
    }
  }, [scrollRef])

  // Initial scroll to bottom
  useEffect(() => {
    if (isInitialMount.current && dependencies.length > 0) {
      scrollToBottom('auto')
      isInitialMount.current = false
    }
  }, [dependencies.length, scrollToBottom])

  // Follow new content only while pinned. Instant (not smooth): repeated
  // streaming updates would otherwise animate continuously and fight the user.
  useEffect(() => {
    if (!isInitialMount.current && pinnedRef.current) {
      scrollToBottom('auto')
    }
  }, [dependencies, scrollToBottom])

  return {
    handleScroll,
    scrollToBottom,
    isAtBottom: () => pinnedRef.current,
  }
}
