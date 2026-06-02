import { useParams, usePathname } from 'next/navigation'
import { useCallback, useMemo, useRef } from 'react'

type SlugResult<T extends string[]> = {
  [K in T[number]]: string | undefined
} & {
  segments: string[]
  setSlug: (...values: (string | undefined)[]) => void
}

/**
 * Reads [[...slug]] route segments as named values and provides a setter
 * that updates the URL without triggering navigation or re-render.
 */
export function useSlug<T extends string[]>(names: T): SlugResult<T> {
  const params = useParams<{ slug?: string[] }>()
  const pathname = usePathname() ?? ''
  const segments = useMemo(() => params?.slug ?? [], [params?.slug])

  const baseRef = useRef('')
  if (!baseRef.current) {
    const suffix = segments.length > 0 ? '/' + segments.join('/') : ''
    baseRef.current = suffix && pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) : pathname
  }

  const setSlug = useCallback((...values: (string | undefined)[]) => {
    const parts = values.filter(Boolean)
    const url = parts.length > 0 ? `${baseRef.current}/${parts.join('/')}` : baseRef.current
    window.history.replaceState(null, '', url)
  }, [])

  return useMemo(() => {
    const result = { segments, setSlug } as SlugResult<T>
    for (let i = 0; i < names.length; i++) {
      ;(result as Record<string, string | undefined>)[names[i]] = segments[i]
    }
    return result
  }, [segments, setSlug, names])
}
