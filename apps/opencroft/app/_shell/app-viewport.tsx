'use client'

import { cn } from 'cn'
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/**
 * An App's viewport and its UI area.
 *
 * The shell's content area is the App's viewport: the whole box beside the
 * title bar and the right sidebar, the strip an overlay sidebar lies over
 * included. The App lays everything out in its UI area, the part of the
 * viewport the sidebar leaves free: an overlay sidebar narrows the UI area
 * from the left as it slides in, while the viewport itself stays where it is.
 *
 * AppViewport is for what must not move when that happens, such as an endless
 * canvas. It fills the whole viewport, behind the App's UI, wherever in the
 * App it is rendered. The App's UI that overlaps it must stack above it
 * (positioned, and later in the page or with a z-index), and what the App
 * frames on it belongs in the part its UI leaves uncovered.
 */

const FrameContext = createContext<HTMLElement | null>(null)

/**
 * The shell's content area. It is positioned, so it is what an AppViewport
 * fills; its padding is what keeps the App's UI area out from under an
 * overlay sidebar.
 */
export function AppViewportFrame({
  className,
  children,
  ref,
  ...props
}: Omit<ComponentProps<'main'>, 'ref'> & { ref?: RefObject<HTMLElement | null> }) {
  const [frame, setFrame] = useState<HTMLElement | null>(null)
  const attach = useCallback(
    (element: HTMLElement | null) => {
      setFrame(element)
      if (ref) ref.current = element
    },
    [ref],
  )
  return (
    <main ref={attach} className={cn('relative', className)} {...props}>
      <FrameContext.Provider value={frame}>{children}</FrameContext.Provider>
    </main>
  )
}

export function AppViewport({ children }: { children: ReactNode }) {
  const frame = useContext(FrameContext)
  const ref = useRef<HTMLDivElement>(null)

  // Filling the viewport rests on the frame being this box's nearest
  // positioned ancestor: any positioned element in between becomes what it
  // fills instead, and that element moves with the UI area.
  useLayoutEffect(() => {
    if (frame && ref.current && ref.current.offsetParent !== frame) {
      console.error(
        'AppViewport: a positioned element sits between it and the shell content area, so it fills that element instead of the viewport.',
      )
    }
  }, [frame])

  return (
    <div ref={ref} data-slot='app-viewport' className='absolute inset-0'>
      {children}
    </div>
  )
}
