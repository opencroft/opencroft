'use client'

import { PanelBottom, PanelLeft, PanelRight } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
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
  /** Which edge the panel occupies. */
  dock: DockSide
  /** Reports the edge chosen in the switch. The value is the caller's, and so
   *  is any persistence of it. Omitted when the caller drives the position
   *  through its own control -- no switch is drawn then. */
  onDockChange?: (side: DockSide) => void
  /** The panel's share of the surface as a percentage, for a caller that
   *  remembers one. Applied once per arrangement rather than continuously, so
   *  it can arrive late -- which it will, since a caller that renders on the
   *  server can only read a per-browser store after mounting. */
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
  const panelRef = useRef<PanelImperativeHandle | null>(null)
  const restoredFor = useRef<string | null>(null)

  // A remembered size is applied to the panel rather than passed as its default
  // size, because a default is spent when the group first lays out and the
  // value is not there yet at that point.
  //
  // Once per arrangement, deliberately: a caller that feeds the size it was
  // just told straight back would otherwise resize the panel under the pointer
  // mid-drag. A share of the surface carries from one arrangement to the next --
  // a third of the width and a third of the height are the same instruction --
  // so moving between the sides and the bottom keeps it rather than resetting.
  useEffect(() => {
    if (size === undefined || restoredFor.current === orientation) {
      return
    }
    // Nothing to resize yet: leave the arrangement unmarked so a later render
    // tries again. Marking it here would spend the single attempt this effect
    // gets on a panel whose handle is not attached, and nothing would say so.
    const panel = panelRef.current
    if (!panel) {
      return
    }
    // Marked BEFORE the resize, because resizing reports a new layout and a
    // caller that stores what it is told feeds that value straight back here.
    restoredFor.current = orientation
    // A PERCENTAGE STRING, NEVER THE BARE NUMBER. `resize` reads a number as
    // PIXELS and an unsuffixed string as a percentage, while the layout this
    // number was measured from is a percentage -- so handing it back unchanged
    // asks for 34 pixels where the caller meant 34% of the surface. That is
    // under any sane minimum, so the panel lands on its minimum every time and
    // a remembered width looks exactly like one that was never stored.
    panel.resize(`${size}%`)
  }, [size, orientation])

  const panelFirst = dock === 'left'

  const docked = (
    <ResizablePanel
      id={PANEL_ID}
      panelRef={panelRef}
      defaultSize={PANEL_DEFAULT_SIZE}
      minSize={PANEL_MIN_SIZE}
      className='flex min-h-0 min-w-0 flex-col'
    >
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
    </ResizablePanel>
  )

  const body = (
    <ResizablePanel
      id={BODY_ID}
      minSize={BODY_MIN_SIZE}
      className='flex min-h-0 min-w-0 flex-col'
    >
      {children}
    </ResizablePanel>
  )

  // Keyed on orientation so moving to or from the bottom re-lays the group out
  // from scratch. Left and right are a reorder, which the stable panel ids
  // handle on their own; horizontal to vertical is a different arrangement.
  return (
    <ResizablePanelGroup
      key={orientation}
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
      {panelFirst ? docked : body}
      <ResizableHandle withHandle />
      {panelFirst ? body : docked}
    </ResizablePanelGroup>
  )
}
