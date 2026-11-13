'use client'

import {
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
  useEffect,
  useRef,
  useState,
} from 'react'

// Which input is driving a drag. A list may resolve targets more forgivingly
// under a finger, which has no hover to aim with, than under a mouse.
export type RowDragInput = 'mouse' | 'touch'

export interface RowDragPoint {
  x: number
  y: number
}

export interface RowDragOptions<D, O> {
  // Where dropping `drag` at `point` (viewport coordinates) would land, given
  // the element under that point, `null` where there is none. `null` back
  // means nowhere: the point offers no drop and dropping there does nothing.
  // The list decides every target, nested ones included -- this hook only
  // asks -- so one gesture serves a flat list, folders, and a tree of any depth.
  targetAt: (drag: D, element: Element | null, point: RowDragPoint, input: RowDragInput) => O | null
  // A drop landed on `over`. Read the list's latest state here: for a touch
  // drag this is called from the press's own listeners, not from a render.
  onDrop: (drag: D, over: O) => void
}

export interface RowDragSourceOptions {
  // Off, the row is neither draggable nor held by a touch press (a row being
  // renamed in place, say), and a touch on it reaches what is inside it.
  enabled?: boolean
  // Put on the native drag as `text/plain`.
  text?: string
}

export interface RowDrag<D, O> {
  // What is being dragged, once a drag has started (a mouse drag, or a touch
  // press that moved past the tolerance).
  drag: D | null
  // Where the drag would land now.
  over: O | null
  // A row a still touch hold has picked up, before it moves: draw it lifted.
  lifted: D | null
  // Where a touch drag's finger is, relative to the list's own box, for a
  // ghost that follows it. A mouse drag needs none: the browser draws one.
  ghost: (RowDragPoint & { drag: D }) | null
  // A gesture that could end in a drop is in flight, from the press or the
  // drag start until it ends -- including a touch press picked up and not yet
  // moved, which has no `drag` yet. A list that takes updates from a host
  // holds them while this is set, so the tree never changes under a finger.
  gestureActive: boolean
  // The list's own element. The ghost is placed against it.
  rootRef: RefObject<HTMLDivElement | null>
  // On the list's own element: the mouse drag's target, hit-tested by
  // delegation through `targetAt`.
  rootProps: {
    onDragOver: (e: DragEvent<HTMLElement>) => void
    onDrop: (e: DragEvent<HTMLElement>) => void
    onDragEnd: () => void
  }
  // On each element a drag can start from (a row's wrapper, a folder header).
  sourceProps: (
    drag: D,
    options?: RowDragSourceOptions,
  ) => {
    // Marks the row, so a mouse drag over a row that refuses it shows no drop.
    'data-row-drag-source': ''
    draggable: boolean
    onPointerDownCapture: (e: ReactPointerEvent<HTMLElement>) => void
    onTouchStartCapture: (e: ReactTouchEvent<HTMLElement>) => void
    onContextMenuCapture: (e: ReactMouseEvent<HTMLElement>) => void
    onDragStart: (e: DragEvent<HTMLElement>) => void
  }
}

// Long-press pickup activation constraint (the dnd-kit pattern):
// a press held still this long arms a drag; moving past the tolerance before it
// fires is not a hold. The delay sits well under a natural long press so a drag
// commits before the user expects a menu.
//
// The tolerance is how far a finger may wander and still count as held still.
// Movement is read from pointer events, which report every pixel, and a finger
// held still drifts a few of them, so this is pinned to what the platforms'
// own long press allows: 10 pt on iOS (UILongPressGestureRecognizer's
// allowable movement), 8 dp on Android (the system touch slop). Tighter, and an
// ordinary wobble aborts the hold or turns it into a drag. It also stays below
// the browser's own touch slop -- the distance before it starts a scroll --
// so a still hold never scrolls.
const PICKUP_DELAY_MS = 500
const PICKUP_TOLERANCE_PX = 10
// A release before this many ms since the press started reads as an ordinary
// slow tap -- 200-350ms between touch-down and release is normal -- so the
// menu needs its own, longer bar rather than sharing the pickup delay. Below
// it the gesture is left alone and the row's own tap selects it.
const MENU_DELAY_MS = 1000
// The menu opens only on a finger at rest: one that has not moved more than
// REST_PX for REST_MS. That is measured from the spot the finger last stopped
// on, not from where the press started, so a finger that wobbled and stopped
// is at rest again REST_MS later wherever it stopped inside the tolerance.
// Where the finger is when the menu is due cannot tell a hold that wobbled
// from a drag that started slowly -- both can still be inside the tolerance
// then, and only the drag is still going. So a moving finger puts the menu
// off until it either comes to rest (a hold: the menu opens) or passes the
// tolerance (a drag); lifting it counts as coming to rest. REST_PX sits above
// the pixel or two of jitter a resting finger reports; a drag slower than
// REST_PX per REST_MS (6 px/s) reads as resting, which leaves a deliberately
// slow drag -- 15 px over a second -- well clear of it. The price is that a
// hold which wobbled gets its menu up to REST_MS after the last wobble.
const REST_PX = 3
const REST_MS = 500

// A single short pulse, fired identically at each stage the gesture reaches --
// armed, then menu-open -- so the two read as one escalation rather than two
// different effects. Feature-detected only: iOS Safari has no Vibration API at
// all and silently gets nothing from this, independent of whatever native
// haptic a platform's own long-press/context-menu handling may already give.
const HAPTIC_PULSE_MS = 15
function vibrate() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(HAPTIC_PULSE_MS)
  }
}

// An in-flight touch press on a row. Held in a ref (no re-render) until it drags,
// scrolls, or the finger lifts -- also after its own menu timer has opened the
// row menu mid-hold. `pointerMove`/`move`/`end` are the window listeners bound
// for this one press.
interface Press<D> {
  // What the press would drag.
  drag: D
  startX: number
  startY: number
  // Where the finger last came to rest, and whether it has stayed within
  // REST_PX of there for REST_MS (see REST_PX). Timed by `restTimer` rather
  // than by reading a clock: timers run on a monotonic one, and the wall clock
  // can jump.
  restX: number
  restY: number
  atRest: boolean
  // The menu timer has fired; the menu opens as soon as the finger is at rest.
  menuDue: boolean
  committed: boolean
  aborted: boolean
  moved: boolean
  // Set the moment the menu timer opens it mid-hold -- release afterward is
  // just the finger lifting off an already-open menu, not a new decision.
  menuOpened: boolean
  pickupTimer: ReturnType<typeof setTimeout> | null
  menuTimer: ReturnType<typeof setTimeout> | null
  restTimer: ReturnType<typeof setTimeout> | null
  pointerMove?: (e: PointerEvent) => void
  move?: (e: TouchEvent) => void
  end?: (e: TouchEvent) => void
}

function clearPressTimers<D>(p: Press<D>) {
  if (p.pickupTimer) {
    clearTimeout(p.pickupTimer)
    p.pickupTimer = null
  }
  if (p.menuTimer) {
    clearTimeout(p.menuTimer)
    p.menuTimer = null
  }
  if (p.restTimer) {
    clearTimeout(p.restTimer)
    p.restTimer = null
  }
}

// Dragging rows of a list: by mouse, native HTML5 drag and drop; by touch, a
// long press that picks the row up. One press serves scroll, drag and the
// row's context menu, and the list says where a drop lands (`targetAt`), so
// the same gesture drives a list with one folder level and a tree of frames.
//
// Touch gesture arbitration (long-press pickup, no grip): the row
// carries NO grip -- one press serves scroll, drag and menu, and movement tells
// them apart (the dnd-kit `activationConstraint { delay, tolerance }` pattern).
// Finger down starts a ~500ms timer; move past ~10px before it fires is not a
// hold (left to the browser); still within tolerance when it fires arms the row (a
// brief lift). From there movement past the threshold drags it in ANY direction
// (vertical included: filing a row into a folder is a vertical drag). A real
// drag has to take the gesture off the browser, and with no touch-action:none
// element to start from that means a NON-PASSIVE touchmove listener (bound on the
// press) calling preventDefault -- but ONLY once movement passes the drag
// threshold; sub-threshold drift while holding stays uncancelled, or the browser
// has no gesture left. Pointer events can't be cancelled, so they cannot take
// the gesture. Movement itself is read from
// `pointermove` as well, because the browser withholds `touchmove` until the
// finger leaves its touch slop, and a drag shorter than that would otherwise be
// invisible and read as a still hold. The press is ours, so the
// menu is too: a second, independent timer -- MENU_DELAY_MS (kept separate from
// the 500ms pickup delay -- an ordinary slow tap can easily run 200-350ms) --
// opens the row menu mid-hold -- once it has fired and the finger is at rest,
// see REST_PX -- by dispatching a real contextmenu event at the press's start
// point; it does not wait for release.
// The row's context-menu trigger stays enabled throughout, because a menu
// primitive captures the point it anchors the menu to while handling that
// event, and a disabled trigger ignores it. What it does NOT get to keep is its
// own touch long-press, which runs on a fixed 500ms of its own, armed on
// `touchstart`: the element a press starts on takes `touchstart` in the capture
// phase and stops it there, so the trigger inside never arms it. For the length
// of the press the same element also stops any `contextmenu` the press did not
// send itself -- a browser raises one of its own on a touch long-press -- so the
// menu opens on our timer and on nothing else.
// Both timers are cleared if the press aborts as a scroll, and the menu timer
// is also cleared the moment a real drag starts, so it can't pop the menu open
// mid-drag. A press that dragged or opened the menu cancels its own release, so
// the browser does not follow it with a click that would select the row
// under the finger, or close the menu it just opened.
// `draggable` is mouse-only -- off as soon as a touch drives the
// row -- so the browser never starts its own drag from a long press; desktop
// keeps native HTML5 DnD + right-click untouched. Two identical short
// vibration pulses mark the same two moments -- armed, then menu-open -- where
// the Vibration API exists.
export function useRowDrag<D, O>(options: RowDragOptions<D, O>): RowDrag<D, O> {
  const [drag, setDrag] = useState<D | null>(null)
  const [over, setOver] = useState<O | null>(null)
  const [lifted, setLifted] = useState<D | null>(null)
  const [ghost, setGhost] = useState<(RowDragPoint & { drag: D }) | null>(null)
  // Set synchronously when a press or a mouse drag starts, cleared when it ends.
  // Not derived from `drag`/`ghost`: a touch press picked up but not yet moved
  // past the threshold has neither, and a host update landing in that window
  // would rebuild the list under a finger still holding a row.
  const [gestureActive, setGestureActive] = useState(false)
  // True once the row is being driven by touch or pen. While it is, the row is
  // not `draggable`, so the browser never starts its own drag from a long press.
  const [touchInput, setTouchInput] = useState(false)
  // Set only for the duration of our own dispatch, so the `contextmenu` the
  // menu timer sends can be told apart from one the browser raised by itself.
  // See `keepForeignMenuOut`.
  const ownMenuDispatchRef = useRef(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const pressRef = useRef<Press<D> | null>(null)
  // The latest options, for the press's window listeners: they are bound once
  // per press and outlive the render that bound them.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const reset = () => {
    setDrag(null)
    setOver(null)
    setGestureActive(false)
  }

  // Tear down an in-flight touch press (timers + window listeners) and clear
  // its visual state, for a list that unmounts mid-gesture.
  const cancelPress = () => {
    const p = pressRef.current
    if (!p) {
      return
    }
    clearPressTimers(p)
    if (p.pointerMove) {
      window.removeEventListener('pointermove', p.pointerMove)
    }
    if (p.move) {
      window.removeEventListener('touchmove', p.move)
    }
    if (p.end) {
      window.removeEventListener('touchend', p.end)
      window.removeEventListener('touchcancel', p.end)
    }
    pressRef.current = null
    setLifted(null)
    setGestureActive(false)
  }

  // What the point under a finger would take. Touch has no native dragover to
  // hit-test with, so it is done by hand via `elementFromPoint`.
  const touchTargetAt = (d: D, x: number, y: number): O | null => {
    if (typeof document === 'undefined') {
      return null
    }
    return optionsRef.current.targetAt(d, document.elementFromPoint(x, y), { x, y }, 'touch')
  }

  // Open a row's context menu at a point by dispatching a real contextmenu
  // event there. The trigger has to actually handle an event to capture the
  // point it anchors the menu to, so the menu is opened the way a right-click
  // opens it rather than by any state of ours. The trigger is listening the
  // whole time -- nothing disables it -- so the event opens the menu in the
  // same task it is sent in.
  const openRowMenuAt = (x: number, y: number) => {
    if (typeof document === 'undefined') {
      return
    }
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) {
      return
    }
    ownMenuDispatchRef.current = true
    try {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
    } finally {
      ownMenuDispatchRef.current = false
    }
  }

  // Capture-phase `contextmenu` on a drag source. While a touch press is
  // in flight the menu is the press's to open, at MENU_DELAY_MS: a browser
  // raises a `contextmenu` of its own on a touch long-press, and letting it
  // through would open the menu at the pickup stage and end the drag before it
  // began. Outside a press -- a right-click -- it passes untouched.
  const keepForeignMenuOut = (e: ReactMouseEvent<HTMLElement>) => {
    if (!pressRef.current || ownMenuDispatchRef.current) {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  // One press serves scroll, drag and menu; movement tells them apart. On finger
  // down we start a PICKUP_DELAY_MS timer and watch for movement. Move past the
  // tolerance before it fires -> not a hold, and the gesture is left to the
  // browser (nothing was cancelled). Still within tolerance when it fires -> arm
  // the row (lift). After that, movement past the tolerance drags it
  // (preventDefault only then -- drift while holding stays uncancelled, or the
  // browser has no gesture left). A second, independent timer opens the row's
  // menu mid-hold, at MENU_DELAY_MS or later once the finger is at rest,
  // without waiting for release -- release afterward is cancelled so the
  // browser raises no click.
  const startPress = (d: D, e: ReactTouchEvent<HTMLElement>) => {
    if (pressRef.current) {
      return
    }
    // The gesture owns the list from here until `end`, including the armed
    // window before any movement.
    setGestureActive(true)
    const t0 = e.touches[0]
    const p: Press<D> = {
      drag: d,
      startX: t0.clientX,
      startY: t0.clientY,
      restX: t0.clientX,
      restY: t0.clientY,
      atRest: true,
      menuDue: false,
      committed: false,
      aborted: false,
      moved: false,
      menuOpened: false,
      pickupTimer: null,
      menuTimer: null,
      restTimer: null,
    }
    pressRef.current = p

    // Opens the menu once both have happened: the menu timer has fired, and
    // the finger is at rest. Called from either side, whichever comes second.
    const openMenuIfDue = () => {
      if (pressRef.current !== p || p.aborted || p.moved || p.menuOpened) {
        return
      }
      if (!p.menuDue || !p.atRest) {
        return
      }
      // Held, armed, at rest and never dragged -> open the menu right now,
      // without waiting for release. Dispatch a real contextmenu at the start
      // point -- within the tolerance of the finger, so still on the row -- so
      // the primitive captures a correct anchor.
      p.menuOpened = true
      setLifted(null)
      vibrate()
      openRowMenuAt(p.startX, p.startY)
    }

    // The finger left the spot it rested on: it is moving until it has stayed
    // within REST_PX of a new spot for REST_MS.
    const noteRestlessness = (x: number, y: number) => {
      if (Math.max(Math.abs(x - p.restX), Math.abs(y - p.restY)) <= REST_PX) {
        return
      }
      p.restX = x
      p.restY = y
      p.atRest = false
      if (p.restTimer) {
        clearTimeout(p.restTimer)
      }
      p.restTimer = setTimeout(() => {
        p.restTimer = null
        p.atRest = true
        openMenuIfDue()
      }, REST_MS)
    }

    // The finger moved to (x, y). Fed from two streams, because neither sees the
    // whole gesture on its own: the browser holds `touchmove` back until the
    // finger leaves its touch slop (tens of pixels on a phone), so the start of
    // a drag -- and a short one, such as a folder onto its neighbour -- reaches
    // `pointermove` only; and `pointermove` ends with a `pointercancel` if the
    // browser takes the gesture anyway, which `touchmove` outlives.
    const follow = (x: number, y: number) => {
      if (pressRef.current !== p || p.menuOpened || p.aborted) {
        return
      }
      noteRestlessness(x, y)
      const dx = x - p.startX
      const dy = y - p.startY
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      if (!p.committed) {
        if (dist > PICKUP_TOLERANCE_PX) {
          // Moved past the tolerance before the pickup delay -> not a hold. The
          // press stops acting and cancels nothing, so the browser does what it
          // would have done without us: it scrolls once the finger passes its
          // own touch slop, and treats a release short of that as a tap.
          p.aborted = true
          clearPressTimers(p)
          setLifted(null)
        }
        return
      }
      // Armed. A held finger drifts a few pixels; that sub-tolerance drift
      // must NOT be cancelled -- the browser needs an uncancelled press, and we
      // only take the gesture once this is a real drag. So preventDefault (and
      // the drag itself) start only past the tolerance; drift below it leaves
      // the press live so the menu timer can still open the menu.
      if (!p.moved) {
        if (dist <= PICKUP_TOLERANCE_PX) {
          return
        }
        p.moved = true
        clearPressTimers(p)
        setLifted(null)
        setDrag(p.drag)
      }
      // Real drag: follow the finger. The point is stored relative to the list,
      // since that is what the ghost is placed against; hit-testing below keeps
      // using the raw viewport coordinates.
      const box = rootRef.current?.getBoundingClientRect()
      setGhost({ drag: p.drag, x: x - (box?.left ?? 0), y: y - (box?.top ?? 0) })
      setOver(touchTargetAt(p.drag, x, y))
    }

    // Observes only: a pointer event cannot be cancelled, so it cannot keep
    // the browser from scrolling. The first finger only -- a second one is not
    // this press.
    const pointerMove = (ev: PointerEvent) => {
      if (ev.pointerType === 'mouse' || !ev.isPrimary) {
        return
      }
      follow(ev.clientX, ev.clientY)
    }

    // Takes the gesture off the browser once this is a real drag: cancelling
    // the first `touchmove` past the slop is what stops the browser from
    // panning the list under a dragged row.
    const move = (ev: TouchEvent) => {
      const t = ev.touches[0]
      follow(t.clientX, t.clientY)
      if (pressRef.current === p && p.moved && ev.cancelable) {
        ev.preventDefault()
      }
    }

    const end = (ev: TouchEvent) => {
      if (pressRef.current !== p) {
        return
      }
      clearPressTimers(p)
      // Held past the menu's moment but still moving a little -- inside the
      // tolerance, so not a drag -- when the finger lifts. A finger often rolls a
      // few pixels as it comes off the glass, and a hold that long was asking
      // for the menu, not a tap. Lifting ends the movement, so it counts as
      // coming to rest: the menu opens now, and the release is cancelled below
      // like any other that opened the menu.
      if (p.menuDue) {
        p.atRest = true
        openMenuIfDue()
      }
      const t = ev.changedTouches[0]
      if (p.committed && p.moved) {
        const target = touchTargetAt(p.drag, t.clientX, t.clientY)
        if (target) {
          optionsRef.current.onDrop(p.drag, target)
        }
      }
      // A drag, or a hold that opened the menu, is not a tap -- but a drag
      // shorter than the browser's touch slop looks like one to the browser,
      // which follows the release with mouse events and a click: on the row
      // under the finger, or on the open menu's trigger, closing it.
      // Cancelling the release suppresses all of them. Anything else is a tap
      // or a scroll and keeps its click, which selects the row.
      if ((p.moved || p.menuOpened) && ev.cancelable) {
        ev.preventDefault()
      }
      setGhost(null)
      setLifted(null)
      setDrag(null)
      setOver(null)
      setGestureActive(false)
      pressRef.current = null
      window.removeEventListener('pointermove', pointerMove)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', end)
      window.removeEventListener('touchcancel', end)
    }

    p.pointerMove = pointerMove
    p.move = move
    p.end = end

    p.pickupTimer = setTimeout(() => {
      if (pressRef.current !== p || p.aborted) {
        return
      }
      // Held still within tolerance for the delay -> pick the row up.
      p.committed = true
      setLifted(p.drag)
      vibrate()
    }, PICKUP_DELAY_MS)

    p.menuTimer = setTimeout(() => {
      p.menuTimer = null
      p.menuDue = true
      openMenuIfDue()
    }, MENU_DELAY_MS)

    window.addEventListener('pointermove', pointerMove)
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', end)
    window.addEventListener('touchcancel', end)
  }

  // Drop any in-flight press if the list unmounts mid-gesture (no listener leak).
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount only; cancelPress reads refs and state setters, which are stable
  useEffect(() => () => cancelPress(), [])

  // A mouse drag over anything outside the list, another list beside it
  // included, offers no drop here. The list's own `onDragOver` never hears
  // of those points, so the document is watched while this list's drag runs.
  useEffect(() => {
    if (drag === null) {
      return
    }
    const clearOutside = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOver(null)
      }
    }
    document.addEventListener('dragover', clearOutside, true)
    return () => document.removeEventListener('dragover', clearOutside, true)
  }, [drag])

  const mouseTargetAt = (e: DragEvent<HTMLElement>): O | null =>
    drag === null
      ? null
      : optionsRef.current.targetAt(drag, e.target as Element, { x: e.clientX, y: e.clientY }, 'mouse')

  return {
    drag,
    over,
    lifted,
    ghost,
    gestureActive,
    rootRef,
    rootProps: {
      // A point that takes the drag accepts it. A row that refuses it clears
      // the target, since a drop there does nothing. Anywhere else in the
      // list, such as the gap between two rows, offers no drop but leaves the
      // last target drawn until the pointer reaches another, so the line does
      // not flicker off and on as the pointer crosses from row to row.
      onDragOver: (e) => {
        const target = mouseTargetAt(e)
        if (!target) {
          if ((e.target as Element).closest('[data-row-drag-source]')) {
            setOver(null)
          }
          return
        }
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setOver(target)
      },
      onDrop: (e) => {
        e.preventDefault()
        e.stopPropagation()
        const target = mouseTargetAt(e)
        if (drag !== null && target) {
          optionsRef.current.onDrop(drag, target)
        }
        reset()
      },
      onDragEnd: reset,
    },
    sourceProps: (d, { enabled = true, text } = {}) => ({
      'data-row-drag-source': '',
      draggable: enabled && !touchInput,
      // Which input the row is being used with right now, taken from the event
      // rather than from a `(pointer: coarse)` media query -- that query
      // describes the primary input device, so it reads false on a machine
      // driven by a mouse that also has a touchscreen, while touch still works
      // there.
      onPointerDownCapture: (e) => setTouchInput(e.pointerType !== 'mouse'),
      // Capture phase, on the element a press starts on. Stopping `touchstart`
      // here, before it reaches a context-menu trigger inside, keeps the
      // trigger's own fixed-delay touch long-press out of a press this hook
      // runs itself. Only `touchstart` is stopped: that is the one the trigger
      // arms on, and the press's own `touchmove`/`touchend` listeners are on
      // the window.
      onTouchStartCapture: (e) => {
        if (!enabled) {
          return
        }
        e.stopPropagation()
        startPress(d, e)
      },
      onContextMenuCapture: keepForeignMenuOut,
      onDragStart: (e) => {
        if (!enabled) {
          return
        }
        setGestureActive(true)
        setDrag(d)
        e.dataTransfer.effectAllowed = 'move'
        if (text !== undefined) {
          e.dataTransfer.setData('text/plain', text)
        }
      },
    }),
  }
}
