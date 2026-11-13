'use client'

import { PanelBottom, PanelLeft, PanelRight } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PanelImperativeHandle } from 'react-resizable-panels'

import { Button } from 'ui/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from 'ui/components/ui/resizable'
import { cn } from 'cn'

/** The edges a panel can be docked to. */
export const DOCK_SIDES = ['left', 'right', 'bottom'] as const

export type DockSide = (typeof DOCK_SIDES)[number]

// The icon shows where the panel lands, which a word only describes. Each one
// still carries its wording as an aria-label and a title: an icon-only control
// leaves a screen reader with nothing to read, and these three differ from one
// another only by which edge the glyph fills.
const DOCK_ICONS = {
  left: PanelLeft,
  right: PanelRight,
  bottom: PanelBottom,
}

const DOCK_LABELS: Record<DockSide, string> = {
  left: 'Dock the panel to the left',
  right: 'Dock the panel to the right',
  bottom: 'Dock the panel to the bottom',
}

// The panel and the surface, as ids rather than positions: the two swap places
// between the left dock and the other two, so what a layout says about "the
// panel" has to survive the swap. Which one comes first is decided by the order
// they are rendered in and by nothing else -- there is no ordering prop to set.
const PANEL_ID = 'dock-panel'
const BODY_ID = 'dock-body'

// The panel opens at about a third and stops at a fifth; the body keeps a third
// of the surface whatever the panel does. Fixed rather than props: every
// surface that docks a panel wants the same proportions, and a size per caller
// is how two surfaces meant to match stop matching.
const PANEL_DEFAULT_SIZE = '34%'
const PANEL_MIN_SIZE = '18%'
const BODY_MIN_SIZE = '30%'

function DockSideSwitch({ dock, onDockChange }: { dock: DockSide; onDockChange: (side: DockSide) => void }) {
  return (
    <div role='group' aria-label='Panel position' className='flex items-center gap-0.5 text-muted-foreground'>
      {DOCK_SIDES.map((side) => {
        const Icon = DOCK_ICONS[side]
        return (
          <Button
            key={side}
            type='button'
            size='icon-xs'
            variant={dock === side ? 'secondary' : 'ghost'}
            aria-pressed={dock === side}
            aria-label={DOCK_LABELS[side]}
            title={DOCK_LABELS[side]}
            onClick={() => onDockChange(side)}
          >
            <Icon />
          </Button>
        )
      })}
    </div>
  )
}

export interface DockPanelProps {
  /** Whether the panel is shown. On by default. The surface stays mounted
   *  whichever way this goes, and when the panel moves between edges: a caller
   *  that shows and hides its panel through this prop, rather than by
   *  rendering the DockPanel or not, keeps the surface's state (a canvas, a
   *  scroll position) across both. The panel's content stays mounted while
   *  the panel moves between edges, and is mounted afresh when it is shown
   *  again. */
  open?: boolean
  /** Which edge the panel occupies, while it is shown. */
  dock: DockSide
  /** Reports the edge chosen in the switch. The value is the caller's, and so
   *  is any persistence of it. Omitted when the caller drives the position
   *  through its own control -- no switch is drawn then. */
  onDockChange?: (side: DockSide) => void
  /** The panel's share of the surface as a percentage, for a caller that
   *  remembers one. The panel opens at it, on every edge, and a size that
   *  arrives after the panel opened is applied once -- which it will be, since
   *  a caller that renders on the server can only read a per-browser store
   *  after mounting. Not applied continuously. Without it the panel opens at
   *  the default size each time it opens or changes edges, since each edge
   *  has a panel of its own; a caller that wants a dragged size kept passes
   *  it back here from `onSizeChange`. */
  size?: number
  /** The panel's share of the surface, reported when a drag ENDS rather than
   *  on every pointer move, so writing it straight to a store is safe. */
  onSizeChange?: (size: number) => void
  /** Whether the panel draws its header row. On by default; a caller whose
   *  panel content draws its own header -- one that has to change with what
   *  the panel shows -- turns it off, and `title`, `actions` and the position
   *  switch go with it. */
  showHeader?: boolean
  /** Shown at the start of the panel's header. A string is drawn as a muted
   *  caption; any other node is placed as given, so a caller that draws the
   *  same header content in other arrangements can hand the SAME node here. */
  title?: ReactNode
  /** Extra controls in the panel's header, ahead of the position switch. */
  actions?: ReactNode
  /** What the panel holds. */
  panel: ReactNode
  /** The surface the panel is docked beside. */
  children: ReactNode
  className?: string
}

/**
 * A surface with a companion panel docked to one of its edges.
 *
 * Controlled: where the panel sits and how big it is arrive as props and leave
 * as callbacks, so the panel never decides either for itself. A caller that
 * remembers them does it in whatever store it already has -- which is also why
 * there is no storage in here: a component that read one at mount would have to
 * guess what a server-rendered caller should show before it can read anything.
 */
export function DockPanel({
  open = true,
  dock,
  onDockChange,
  size,
  onSizeChange,
  showHeader = true,
  title,
  actions,
  panel,
  children,
  className,
}: DockPanelProps) {
  const orientation = dock === 'bottom' ? 'vertical' : 'horizontal'
  const panelFirst = dock === 'left'
  // Made after mounting rather than during the first render: there is no
  // document on the server, and the first render in the browser hydrates
  // what the server drew. A panel shown from the start draws its content from
  // the commit after.
  const [content, setContent] = useState<HTMLElement | null>(null)
  useEffect(() => setContent(createContentElement()), [])
  const adoptContent = useCallback(
    (slot: HTMLDivElement | null) => {
      if (slot && content) {
        slot.appendChild(content)
      }
    },
    [content],
  )

  const contentChildren = (
    <>
      {showHeader ? (
        <div className='flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1'>
          {/* A string is dressed as the panel's own caption; a node is placed as
              it came. Wrapping a node too put a flex block inside an inline,
              truncating span, whose overflow clip cut off whatever the node let
              hang past its line box -- an avatar's status dot, for one. */}
          {typeof title === 'string' ? <span className='truncate text-xs text-muted-foreground'>{title}</span> : title}
          <div className='flex shrink-0 items-center gap-0.5'>
            {actions}
            {onDockChange ? <DockSideSwitch dock={dock} onDockChange={onDockChange} /> : null}
          </div>
        </div>
      ) : null}
      <div className='flex min-h-0 flex-1 flex-col'>{panel}</div>
    </>
  )

  const body = (
    <ResizablePanel
      key={BODY_ID}
      id={BODY_ID}
      minSize={BODY_MIN_SIZE}
      className='flex min-h-0 min-w-0 flex-col'
    >
      {children}
    </ResizablePanel>
  )

  // One group in every arrangement, so the surface is the same element when
  // the panel opens, closes or changes edges. The surface is also never MOVED
  // among the group's children: the docked panel and its handle are keyed by
  // edge, so a change of edge takes one pair out and puts another in around
  // the surface. React re-runs a moved element's effects in a development
  // build under StrictMode, which for a canvas means loading it again.
  //
  // What the panel shows is drawn once, into an element of its own that each
  // docked panel adopts (`adoptContent`), so it is not remounted by the change
  // of panel either. A panel opens at the remembered size: each one is a new
  // panel, and its default size is the size it is given.
  const docked = open ? (
    <DockedPanel key={`panel-${dock}`} size={size} adoptContent={adoptContent} />
  ) : null
  const handle = open ? <ResizableHandle key={`handle-${dock}`} withHandle className='z-10' /> : null
  return (
    <>
      <ResizablePanelGroup
        orientation={orientation}
        className={cn('min-h-0', className)}
        onLayoutChanged={
          onSizeChange
            ? (layout) => {
                const next = layout[PANEL_ID]
                if (typeof next === 'number') {
                  onSizeChange(next)
                }
              }
            : undefined
        }
      >
        {panelFirst ? docked : null}
        {panelFirst ? handle : null}
        {body}
        {panelFirst ? null : handle}
        {panelFirst ? null : docked}
      </ResizablePanelGroup>
      {open && content ? createPortal(contentChildren, content) : null}
    </>
  )
}

function createContentElement() {
  const element = document.createElement('div')
  element.className = 'flex min-h-0 flex-1 flex-col'
  return element
}

/**
 * The docked panel. The panel and the handle stack above the surface and the
 * panel is opaque, so a surface that draws past its own box -- a canvas
 * reaching under the panel -- is covered by them rather than drawn over them,
 * on either side.
 */
function DockedPanel({
  size,
  adoptContent,
}: {
  size?: number
  adoptContent: (slot: HTMLDivElement | null) => void
}) {
  // A PERCENTAGE STRING, NEVER THE BARE NUMBER, here and in `resize` below:
  // both read a number as PIXELS and an unsuffixed string as a percentage,
  // while the layout this number was measured from is a percentage -- so
  // handing it back unchanged asks for 34 pixels where the caller meant 34% of
  // the surface. That is under any sane minimum, so the panel lands on its
  // minimum every time and a remembered width looks exactly like one that was
  // never stored.
  const [opensAt] = useState(size)
  const panelRef = useRef<PanelImperativeHandle | null>(null)
  const sized = useRef(opensAt !== undefined)

  // A remembered size that arrives after the panel opened -- a caller that
  // renders on the server can only read a per-browser store after mounting --
  // is applied once, by resizing. Only once, deliberately: a caller that feeds
  // the size it was just told straight back would otherwise resize the panel
  // under the pointer mid-drag. Not in the commit that opens the panel, which
  // takes its default size instead: the group has no layout for the panel
  // until it has laid itself out with it, and `resize` throws before then.
  useEffect(() => {
    const panel = panelRef.current
    if (sized.current || size === undefined || !panel) {
      return
    }
    // Marked BEFORE the resize, because resizing reports a new layout and a
    // caller that stores what it is told feeds that value straight back here.
    sized.current = true
    panel.resize(`${size}%`)
  }, [size])

  return (
    <ResizablePanel
      id={PANEL_ID}
      panelRef={panelRef}
      defaultSize={opensAt === undefined ? PANEL_DEFAULT_SIZE : `${opensAt}%`}
      minSize={PANEL_MIN_SIZE}
      className='relative z-10 flex min-h-0 min-w-0 flex-col bg-background'
    >
      <div ref={adoptContent} className='flex min-h-0 flex-1 flex-col' />
    </ResizablePanel>
  )
}
