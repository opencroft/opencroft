'use client'

import { type ReactFlowState, useStore, useStoreApi } from '@xyflow/react'
import { type ReactNode, useCallback, useLayoutEffect, useRef } from 'react'

import { ceilToGrid, ownSize } from '@/app/_authed/(extension-runtime)/_grid'

// What a ResizeObserver cannot see is a shrink: the component is stretched to
// the box, so when its content gets smaller the component keeps its size. A
// change to the content's elements, text or state is the signal instead.
// `style` is left out because the box writes its own; content that resizes
// itself through an inline style alone keeps the larger size until its next
// other change.
const CONTENT_CHANGES: MutationObserverInit = {
  subtree: true,
  childList: true,
  characterData: true,
  attributeFilter: ['class', 'hidden', 'open', 'data-state'],
}

/**
 * The box a node's component is drawn in. On each axis where the node holds no
 * size of its own (see `ownSize`), the box is its content's size rounded up to
 * the grid and the component is stretched to fill it, so a card sized by its
 * content has its edges on grid lines like one a person resized. On an axis
 * the node does size, the box fills the node, and the component with it.
 *
 * Measured rather than styled, because CSS cannot round an intrinsic size. A
 * measurement drops the box's minimum, reads the content's own size and sets
 * the rounded one in one task, so no frame is painted unrounded and the
 * canvas's own observer only ever sees the rounded size.
 */
export function GridSizedBox({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const store = useStoreApi()
  // A string, so the selector's answer compares by value across renders.
  const contentAxes = useStore(
    useCallback(
      (s: ReactFlowState) => {
        const node = s.nodeLookup.get(nodeId)
        const own = node ? ownSize(node) : {}
        return `${own.width === undefined ? 'w' : ''}${own.height === undefined ? 'h' : ''}`
      },
      [nodeId],
    ),
  )
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const box = ref.current
    if (!box) {
      return
    }
    const roundWidth = contentAxes.includes('w')
    const roundHeight = contentAxes.includes('h')
    box.style.minWidth = ''
    box.style.minHeight = ''
    if (!roundWidth && !roundHeight) {
      return
    }
    let frame = 0
    const measure = () => {
      frame = 0
      box.style.minWidth = ''
      box.style.minHeight = ''
      // The viewport's zoom is a transform on an ancestor, so the rect is in
      // screen pixels; the grid is in canvas pixels.
      const zoom = store.getState().transform[2]
      const rect = box.getBoundingClientRect()
      if (roundWidth) {
        box.style.minWidth = `${ceilToGrid(rect.width / zoom)}px`
      }
      if (roundHeight) {
        box.style.minHeight = `${ceilToGrid(rect.height / zoom)}px`
      }
    }
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(measure)
      }
    }
    measure()
    // Growth: the box grows with its content past the minimum it was given.
    // Setting the same minimum again changes no size, so this settles.
    const resize = new ResizeObserver(schedule)
    resize.observe(box)
    const mutation = new MutationObserver(schedule)
    mutation.observe(box, CONTENT_CHANGES)
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
    }
  }, [contentAxes, store])

  return (
    <div ref={ref} className='flex h-full w-full flex-col [&>*]:grow'>
      {children}
    </div>
  )
}
