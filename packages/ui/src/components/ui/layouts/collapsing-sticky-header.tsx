'use client'

import * as React from 'react'

import { cn } from 'cn'

// A sticky header whose content scrolls away like ordinary content and hands
// over to a short preview only at the very end.
//
// Two failures this exists to make impossible:
//
//   * A header that shrinks once it becomes stuck changes its own height at
//     the very boundary that decides whether it is stuck. Shrinking pulls the
//     content up, which unsticks it, which grows it back -- the view
//     oscillates and the reader cannot hold a position.
//   * A header that starts collapsing the moment it reaches the top can never
//     be READ. A message taller than the screen is already shrinking by the
//     time the reader arrives at it, so the words go past unread.
//
// So nothing here shrinks, and nothing begins early:
//
//   * the header keeps its full height in normal flow, always. Its content
//     scrolls away exactly like ordinary content, and a long message reads
//     like a long message;
//   * the slide IS the browser's own sticky slide -- `top` is negative by
//     exactly the distance that should scroll away, so the header travels off
//     the container's edge and the preview stays behind;
//   * only once the slide has finished -- the header pinned, the preview's
//     strip all that is left in view -- do the two forms swap, instantly and
//     with no transition. A fade runs for a fixed time while the scroll
//     carries on, so a fast or long scroll would show the outgoing form
//     dissolving over the content passing beneath it. Before that, the full
//     form occupies the very lines the preview would cover, so swapping
//     earlier would blank the rest of it above the preview and leave a gap.
//     Whether the slide has finished is read from the scroll offset and
//     drives appearance only. Nothing in the layout may read it back.
//
// The swap is a state with two values, not a position along a ramp, so a
// scroll that stops anywhere -- including a last turn too short to scroll the
// whole travel, which simply keeps its full form -- leaves exactly one form
// showing, fully.
//
// Because the geometry is CSS rather than JavaScript, a dropped frame or a
// late measurement can only delay the swap. It can never move the page.
//
// Compound, so the host says which part does what:
//
//   <CollapsingStickyHeader>
//     <CollapsingStickyHeaderPinned><Avatar /></CollapsingStickyHeaderPinned>
//     <CollapsingStickyHeaderContent preview={<Bubble lines={3} />}>
//       <Bubble />
//     </CollapsingStickyHeaderContent>
//   </CollapsingStickyHeader>
//
// `Pinned` holds the container's edge while everything else slides past it, so
// an avatar is rendered ONCE and never swaps with a copy of itself.
// Anything not wrapped in either part simply scrolls away with the rest.

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

export type ScrollContainerRef = React.RefObject<HTMLElement | null>

const ScrollContainerContext = React.createContext<ScrollContainerRef | null>(null)

/** Lets a scrolling element announce itself, so headers deeper in the tree do
    not each need the ref threading through their props. */
export function ScrollContainerProvider({
  containerRef,
  children,
}: {
  containerRef: ScrollContainerRef
  children: React.ReactNode
}) {
  return <ScrollContainerContext.Provider value={containerRef}>{children}</ScrollContainerContext.Provider>
}

export function useScrollContainer() {
  return React.useContext(ScrollContainerContext)
}

const SCROLLABLE = /auto|scroll|overlay/

// Last resort, when neither a ref nor a provider is given: the nearest ancestor
// that actually scrolls. `null` means the page itself.
function nearestScrollParent(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null
  while (el) {
    if (SCROLLABLE.test(window.getComputedStyle(el).overflowY)) return el
    el = el.parentElement
  }
  return null
}

// The root finds the preview by walking the DOM rather than by having the part
// register through context. Where the preview sits is a fact about the rendered
// tree, and reading it there is what lets a host nest the region anywhere in
// its own layout without telling this component where.
const PREVIEW_ATTR = 'data-collapse-preview'

export interface CollapseState {
  /** The preview has taken over: the slide has finished and the header is
      pinned. False for the whole of the slide before that. */
  collapsed: boolean
}

const CollapseContext = React.createContext<CollapseState | null>(null)

/** The collapse state, for chrome that wants to react further -- a chevron, a
    shadow, a title that changes weight. Everything it returns is appearance;
    nothing in the layout may be derived from it. */
export function useCollapseState(): CollapseState {
  const state = React.useContext(CollapseContext)
  if (!state) {
    throw new Error('useCollapseState must be used inside <CollapsingStickyHeader>')
  }
  return state
}

// How far short of its full travel a header may read and still count as
// pinned. The sticky offset is set from a measured, fractional travel and is
// laid out on the engine's sub-pixel grid, so a pinned header can read a
// fraction of a pixel short -- and without this it would never hand over.
const PINNED_TOLERANCE = 1

/** Whether a header pushed `scrolled` px above its container's edge has handed
    over to its preview: it has slid its whole `travel` and is pinned. One that
    stops short of that -- however close -- still shows its full form, and one
    with no travel never hands over. */
export function isPastHandOver(scrolled: number, travel: number): boolean {
  return travel > 0 && scrolled >= travel - PINNED_TOLERANCE
}

export interface CollapsingStickyHeaderProps extends React.ComponentPropsWithoutRef<'div'> {
  /** The scrolling element. Falls back to the nearest provider, then to the
      nearest scrollable ancestor, then to the page. */
  scrollRef?: ScrollContainerRef
}

export function CollapsingStickyHeader({ children, scrollRef, className, style, ...props }: CollapsingStickyHeaderProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const contextRef = useScrollContainer()

  const [metrics, setMetrics] = React.useState({ travel: 0, collapsed: false })

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    let frame = 0
    let scroller: HTMLElement | null = null

    const measure = () => {
      frame = 0
      const el = rootRef.current
      if (!el) return
      resolveScroller()

      // How far the header must slide before the preview is all that is left:
      // the distance from its own top edge to the preview's. Taken as a
      // difference of RECTS rather than of heights, so any padding, border or
      // chrome between them is already inside the number -- the preview comes
      // to rest inset exactly as it sits at the bottom of the block.
      const rootRect = el.getBoundingClientRect()
      const previewEl = el.querySelector<HTMLElement>(`[${PREVIEW_ATTR}]`)
      const previewRect = previewEl?.getBoundingClientRect() ?? null
      const travel = previewRect ? Math.max(0, previewRect.top - rootRect.top) : 0

      // `clientTop` is the container's top border. Sticky pins against the
      // SCROLLPORT -- the padding box, inside that border -- so measuring from
      // the border-box top would leave the slide short by the border width and
      // it would never quite finish.
      const containerTop = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0

      // How far the header's top edge has been pushed above the container's.
      // Sticky clamps that at exactly the travel. Note what is NOT in this
      // expression: the header's own height. It cannot be, or the oscillation
      // is back.
      const scrolled = containerTop - rootRect.top

      // The swap waits for the end of the travel, so everything before that is
      // an ordinary scroll through content at full opacity, and a message
      // taller than the screen can actually be read.
      //
      // There is no hysteresis band around the point, because nothing can
      // bounce across it on its own: the state drives opacity only, so
      // flipping it moves no geometry and produces no scroll event. Only the
      // reader's own scrolling crosses it.
      const collapsed = isPastHandOver(scrolled, travel)

      setMetrics((prev) =>
        prev.travel === travel && prev.collapsed === collapsed ? prev : { travel, collapsed },
      )
    }

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }

    // Content that grows or shrinks mid-slide changes where the header rests
    // and how far it has to travel. Both are re-read here; neither can move the
    // scroll, because neither is derived from the collapse state.
    const observer = new ResizeObserver(schedule)

    // Which element scrolls is read from computed style, and computed style is
    // not trustworthy at the instant a layout effect runs: a stylesheet that
    // has not applied yet reports `overflow: visible` for the very element that
    // scrolls. Resolved once and kept, a wrong answer there is permanent -- the
    // header measures against the viewport and never collapses at all. So a
    // miss means "not yet" and is retried on the next measurement; an element,
    // once found, is kept.
    const resolveScroller = () => {
      if (scroller) return scroller
      scroller = scrollRef?.current ?? contextRef?.current ?? nearestScrollParent(rootRef.current)
      if (scroller) observer.observe(scroller)
      return scroller
    }

    // Scroll does not bubble, so a listener bound to the scrollport has to know
    // which element that is before the first scroll arrives -- exactly what is
    // not reliable yet. A capture listener on the document sees scrolling
    // anywhere, so the first scroll both resolves the container and measures
    // against it. Once resolved, every other scroller is filtered back out.
    const onScroll = (event: Event) => {
      if (scroller && event.target !== scroller && event.target !== document) return
      schedule()
    }

    observer.observe(root)

    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', schedule)

    measure()

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', schedule)
      observer.disconnect()
    }
  }, [scrollRef, contextRef])

  const state: CollapseState = { collapsed: metrics.collapsed }

  return (
    <CollapseContext.Provider value={state}>
      <div
        ref={rootRef}
        data-collapsed={state.collapsed}
        // `z-1` is exact, not a round number. It must EXCEED the content
        // passing underneath -- which typically wraps itself in a `relative`
        // box, landing at z-index 0 and later in document order, so anything
        // lower loses on tree order and that content paints over the header.
        // It must not exceed a composer or toolbar pinned at the other edge,
        // conventionally `z-1` too and later still, so equal values break by
        // tree order and it keeps painting over this. No integer sits between
        // those two bounds.
        //
        // `bg-background` is occlusion, not decoration: without it the content
        // passing underneath shows through the header. A host supplying its own
        // backing -- a gradient, a card -- overrides it through `className`.
        className={cn('sticky z-1 bg-background', className)}
        style={
          {
            // Negative by the whole travel, so the header scrolls away like
            // ordinary content and pins only once the preview is what is left.
            // The height it occupies in flow is its natural one and never
            // changes, which is what keeps the collapse out of the layout.
            top: -metrics.travel,
            ...style,
          }
        }
        {...props}
      >
        {children}
      </div>
    </CollapseContext.Provider>
  )
}

/** Holds the container's edge while the rest of the header slides past it.

    For the parts that identify a header rather than fill it -- an avatar, a
    status dot, a rail marker. Rendered once and never faded, so it cannot
    swap with a copy of itself, which is what happens to anything placed in
    both forms of a `Content` region.

    It stays put with `position: sticky`, so the browser holds it against the
    scrollport on the same frame it moves the header.

    It used to cancel the slide with a transform driven by a measured scroll
    offset, and that is what a reader could see: TWO THINGS POSITIONING ONE
    ELEMENT. The header's slide is exact and pre-paint; a measured offset is a
    frame late and quantised by the tolerance that keeps it from re-rendering
    constantly. The residue between them reads as the marker travelling too far
    and settling at offsets nothing accounts for. A second positioner that
    agrees most of the time is worse than either alone, because the
    disagreement is small enough to look like a mis-set constant.

    IT NEEDS A CONTAINING BLOCK TALLER THAN ITSELF, which is what the transform
    bought and this gives up. A sticky box cannot leave its containing block, so
    a parent sized to hug this element gives it nowhere to travel and it does
    nothing at all -- no error, no movement, no way to tell from the outside.
    Place it directly in the column it should hold, never inside a wrapper that
    hugs it.

    It does not reserve the space it moves into, so leave room below it in
    whatever column it sits in -- a rail's connecting line will pass behind it. */
export function CollapsingStickyHeaderPinned({ className, style, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={cn('sticky top-0 z-1', className)}
      style={style}
      {...props}
    />
  )
}

export interface CollapsingStickyHeaderContentProps extends React.ComponentPropsWithoutRef<'div'> {
  /** What is left once the header has slid away. It sits at the BOTTOM of this
      region, out of flow, so it reserves nothing and the region's height stays
      exactly its children's.

      Clamp it in lines -- `line-clamp-3` -- and the resting height is three
      lines of whatever type the host renders, with no pixel stated anywhere. */
  preview?: React.ReactNode
  previewClassName?: string
}

/** The region that hands over: its children scroll away and its `preview` is
    what stays behind, the two swapping once the slide has finished.

    Both forms occupy the same place -- the preview is laid over the children's
    final strip -- so style them alike and the swap lands where the reader is
    already looking. */
export function CollapsingStickyHeaderContent({
  children,
  preview,
  className,
  previewClassName,
  ...props
}: CollapsingStickyHeaderContentProps) {
  const { collapsed } = useCollapseState()
  return (
    <div className={cn('relative', className)} {...props}>
      <div className={cn(collapsed && 'opacity-0')} aria-hidden={collapsed} inert={collapsed || undefined}>
        {children}
      </div>
      <div
        {...{ [PREVIEW_ATTR]: '' }}
        // Out of flow and pinned to this region's bottom edge, so it adds no
        // height of its own and the header's flow box never depends on it.
        // Nothing invisible may take a click aimed at the text underneath it.
        className={cn('absolute inset-x-0 bottom-0', !collapsed && 'pointer-events-none opacity-0', previewClassName)}
        // Exactly one of the two forms is exposed to assistive technology at a
        // time: the preview repeats the children's opening until they are gone,
        // at which point it is all there is.
        aria-hidden={!collapsed}
        inert={!collapsed || undefined}
      >
        {preview}
      </div>
    </div>
  )
}
