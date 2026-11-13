export interface InspectorPlacementInput {
  /** Whether there is something to inspect. */
  open: boolean
  /** The phone layout. */
  isMobile: boolean
  /** Whether the inspector was expanded with its Expand button. */
  expanded: boolean
  /** Whether a phone was asked to show the inspector (a node's Details). */
  mobileVisible: boolean
}

export interface InspectorPlacement {
  /** Expanded as the inspector shows it: what its Expand/Collapse button reads. */
  expanded: boolean
  /** Docked beside the canvas, in the resizable layout. */
  docked: boolean
  /** Covering the whole screen. */
  covers: boolean
}

/**
 * Where the inspector sits: docked beside the canvas on a desktop, covering
 * the screen when expanded or on a phone. Expanding is a desktop state: a
 * phone's inspector has no Collapse, so one expanded before the layout turned
 * to a phone (a phone or tablet rotated from landscape) is not expanded there,
 * and is expanded again if the layout turns back to desktop.
 */
export function inspectorPlacement({
  open,
  isMobile,
  expanded,
  mobileVisible,
}: InspectorPlacementInput): InspectorPlacement {
  const shownExpanded = expanded && !isMobile
  return {
    expanded: shownExpanded,
    docked: open && !isMobile && !shownExpanded,
    covers: open && (shownExpanded || (isMobile && mobileVisible)),
  }
}
