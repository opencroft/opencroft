'use client'

import { NodeResizer, useReactFlow } from '@xyflow/react'

const GRID = 10
const snap = (v: number) => Math.round(v / GRID) * GRID

interface InvisibleResizerProps {
  id: string
  minWidth?: number
  minHeight?: number
}

export function InvisibleResizer({ id, minWidth = 300, minHeight = 200 }: InvisibleResizerProps) {
  const { setNodes } = useReactFlow()

  return (
    <NodeResizer
      isVisible
      minWidth={minWidth}
      minHeight={minHeight}
      onResizeEnd={(_event, { width, height }) => {
        setNodes((nds) =>
          nds.map((n) => (n.id === id ? { ...n, style: { ...n.style, width: snap(width), height: snap(height) } } : n)),
        )
      }}
      lineStyle={{ border: '8px solid transparent', zIndex: 1 }}
      handleStyle={{ background: 'transparent', border: 'none', width: 16, height: 16, zIndex: 1 }}
    />
  )
}
