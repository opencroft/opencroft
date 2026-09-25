'use client'

import { useEffect, useState } from 'react'

interface BuildInfo {
  branch: string
  commit: string
}

const BUILD_INFO_URL = '/api/build-info'

/** `branch@commit` of the running build, or null when the server does not know it. */
export function useBuildLabel(): string | null {
  const [info, setInfo] = useState<BuildInfo | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch(BUILD_INFO_URL, { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<BuildInfo>) : null))
      .then((data) => setInfo(data))
      .catch(() => {})
    return () => controller.abort()
  }, [])

  if (!info) {
    return null
  }

  const label = [
    info.branch !== 'unknown' ? info.branch : null,
    info.commit !== 'unknown' ? info.commit.slice(0, 7) : null,
  ]
    .filter(Boolean)
    .join('@')

  return label || null
}
