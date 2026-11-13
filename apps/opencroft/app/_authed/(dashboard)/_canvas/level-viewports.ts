import { useReactFlow, type Viewport } from '@xyflow/react'
import { useEffect, useRef } from 'react'

/** No level shown yet: the canvas has not stood anywhere to remember. */
const NOT_SHOWN = Symbol('not shown')

/**
 * Where the canvas stands on each level of the graph, per tab. Leaving a level
 * remembers its view; arriving at one shows that view again, then calls
 * `arrived`, with `fit` true the first time the level is shown. The caller
 * decides what a first arrival gets: a fit, or a node it was opened to focus.
 *
 * The level the canvas opens on, the top or one named by the URL, is fitted by
 * the graph's open (fitViewOnOpen), which also leaves a graph that opens empty
 * unfitted; it arrives with `fit` false. While the graph is not ready (a
 * different graph is loading in the same editor) the levels are forgotten, so
 * the next graph opens as the first did.
 */
export function useLevelViewports({
  ready,
  level,
  arrived,
}: {
  ready: boolean
  level: string | undefined
  arrived: (fit: boolean) => void
}) {
  const { getViewport, setViewport } = useReactFlow()
  const viewports = useRef(new Map<string | undefined, Viewport>())
  const shown = useRef<string | undefined | typeof NOT_SHOWN>(NOT_SHOWN)
  useEffect(() => {
    if (!ready) {
      shown.current = NOT_SHOWN
      viewports.current.clear()
      return
    }
    if (shown.current === level) {
      return
    }
    const left = shown.current
    if (left !== NOT_SHOWN) {
      viewports.current.set(left, getViewport())
    }
    shown.current = level
    const saved = viewports.current.get(level)
    if (saved) {
      void setViewport(saved)
    }
    arrived(!saved && left !== NOT_SHOWN)
  }, [ready, level, getViewport, setViewport, arrived])
}
