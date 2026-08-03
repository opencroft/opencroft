'use client'

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

interface InspectorContextValue {
  setNode: (node: ReactNode | null) => void
}

export const InspectorContext = createContext<InspectorContextValue>({
  setNode: () => {},
})

export function useInspector(node: ReactNode | null): void {
  const { setNode } = useContext(InspectorContext)
  useEffect(() => {
    setNode(node)
  }, [node, setNode])
  useEffect(() => () => setNode(null), [setNode])
}

export interface InspectorState {
  inspectorNode: ReactNode | null
  setNode: (node: ReactNode | null) => void
}

export function useInspectorState(): InspectorState {
  const [inspectorNode, setInspectorNode] = useState<ReactNode | null>(null)
  const setNode = useCallback((node: ReactNode | null) => {
    setInspectorNode(node)
  }, [])
  return { inspectorNode, setNode }
}
