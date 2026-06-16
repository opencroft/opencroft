'use client'

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface RecyclingProviderProps<T> {
  items: T[]
  itemsPerPage: number
  children: (props: {
    visibleItems: T[]
    scrollRef: React.RefObject<HTMLDivElement | null>
    onScroll: () => void
  }) => ReactNode
}

export const RecyclingProvider = <T,>({ items, itemsPerPage, children }: RecyclingProviderProps<T>) => {
  const [loadedCount, setLoadedCount] = useState(itemsPerPage)
  const scrollRef = useRef<HTMLDivElement>(null)
  const hasCheckedInitial = useRef(false)

  const visibleItems = useMemo(() => {
    return items.slice(0, loadedCount)
  }, [items, loadedCount])

  const checkAndLoadMore = useCallback(() => {
    if (!scrollRef.current || loadedCount >= items.length) {
      return
    }
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    if (scrollTop + clientHeight >= scrollHeight - clientHeight || scrollHeight <= clientHeight) {
      setLoadedCount((prev) => Math.min(prev + itemsPerPage, items.length))
    }
  }, [loadedCount, items.length, itemsPerPage])

  useEffect(() => {
    setLoadedCount(itemsPerPage)
    hasCheckedInitial.current = false
  }, [items, itemsPerPage])

  useEffect(() => {
    if (!hasCheckedInitial.current) {
      hasCheckedInitial.current = true
      const timer = setTimeout(checkAndLoadMore, 100)
      return () => clearTimeout(timer)
    }
  }, [checkAndLoadMore])

  return <>{children({ visibleItems, scrollRef, onScroll: checkAndLoadMore })}</>
}

export default RecyclingProvider
