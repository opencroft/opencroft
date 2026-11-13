'use client'

// The tooltip of a handle pin given a `tip`: a node shows what passes through
// a pin there rather than beside it, so the pin's row, and the card, keep
// their size whatever the value. A pointer that hovers opens it while over
// the pin. A touch has no hover, so a press on the pin opens it and the next
// press anywhere else closes it.
//
// The pin is React Flow's handle, which spreads the props it is given over
// its own: a handler it sets itself (`onClick`, which connects on click) is
// replaced by one passed in. So the tooltip has no trigger element. The pin
// gets only pointer enter, leave and down, which the handle leaves unset, and
// the popup is anchored to it.
//
// The popup takes no pointer. Its arrow reaches over the pin's top edge, and
// further while it slides in from below as it opens: a popup that took the
// pointer would make the pointer leave the pin as the tip opens, closing it
// again, and would take a tap's click away from the pin's click-to-connect.
// Nothing in the popup is meant to be reached: it closes once the pointer
// leaves the pin.

import {
  cloneElement,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useEffect,
  useState,
} from 'react'
import { Tooltip, TooltipContent } from 'ui/components/ui/tooltip'

// React Flow draws a handle as a div.
interface PinEvents {
  ref?: Ref<HTMLDivElement>
  onPointerEnter?: (event: PointerEvent<HTMLDivElement>) => void
  onPointerLeave?: (event: PointerEvent<HTMLDivElement>) => void
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void
}

/**
 * A pin's xyflow handle, with its tooltip when it has a tip. The handle stays
 * in the same place in the tree with or without one, so a tip that comes and
 * goes doesn't draw the pin anew.
 */
export function PinTip({ pin, tip }: { pin: ReactElement<PinEvents>; tip: ReactNode | undefined }) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)

  // Any press closes it, the capture phase seeing it first. A touch press on
  // the pin itself then opens it again through the pin's own handler, in the
  // same event, so React renders it open throughout.
  useEffect(() => {
    if (!pressed) {
      return
    }
    const close = () => setPressed(false)
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [pressed])

  const own = pin.props
  return (
    <>
      {cloneElement(pin, {
        ref: setAnchor,
        onPointerEnter: (event) => {
          own.onPointerEnter?.(event)
          if (event.pointerType !== 'touch') {
            setHovered(true)
          }
        },
        onPointerLeave: (event) => {
          own.onPointerLeave?.(event)
          setHovered(false)
        },
        onPointerDown: (event) => {
          own.onPointerDown?.(event)
          if (event.pointerType === 'touch') {
            setPressed(true)
          }
        },
      })}
      {tip !== undefined && (
        <Tooltip open={(hovered || pressed) && anchor !== null}>
          <TooltipContent anchor={anchor} className='pointer-events-none whitespace-pre-wrap break-words'>
            {tip}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  )
}
