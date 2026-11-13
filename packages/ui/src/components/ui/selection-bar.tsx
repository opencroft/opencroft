import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  EllipsisVerticalIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "cn"

import { Button } from "./button"
import { Popover, PopoverContent } from "./popover"
import { Separator } from "./separator"

/*
 * A compact bar beside selected text, for any surface whose text can be
 * selected: a row of buttons for what can be done with the selection, then
 * `⋮`, which turns the bar into a list of the rest. Right-click and the
 * platform's own selection menu stay the browser's; the bar sits beside them,
 * never over them, and never in the way of the selection handles.
 *
 * The host knows what is selected and what can be done with it. It passes
 * `useSelectionBar` the selection and the bar the actions; the hook decides
 * when the bar shows and the bar where it sits.
 */

const COARSE_POINTER = "(pointer: coarse)"

function subscribeCoarsePointer(onChange: () => void) {
  const query = window.matchMedia(COARSE_POINTER)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

/** Whether the main pointer is a finger. */
function useCoarsePointer(): boolean {
  return React.useSyncExternalStore(
    subscribeCoarsePointer,
    () => window.matchMedia(COARSE_POINTER).matches,
    () => false
  )
}

/** Marks the bar, so a press inside it is told apart from one on the text. */
const BAR_ATTRIBUTE = "data-selection-bar"

interface MousePress {
  /** Whether the button is still down: a drag still choosing its selection. */
  held: boolean
  /**
   * The selection the press went down on, until the selection changes; null
   * when there was none, or once it has changed.
   */
  on: string | null
}

const NO_MOUSE_PRESS: MousePress = { held: false, on: null }

/**
 * The last press of the main mouse button on `target`. Only the main button:
 * a right-click opens the browser's menu, which can keep the button's release
 * to itself. The bar is never inside `target` (it is portalled), so a press on
 * the bar is not one and leaves the bar open for its click.
 */
function useMousePress(
  target: HTMLElement | null,
  selection: string | null
): MousePress {
  const [press, setPress] = React.useState(NO_MOUSE_PRESS)
  // For the listener, which outlives a render.
  const current = React.useRef(selection)
  React.useEffect(() => {
    current.current = selection
  }, [selection])
  React.useEffect(() => {
    if (!target) {
      return
    }
    const onDown = (event: Event) => {
      const pointer = event as PointerEvent
      if (pointer.pointerType !== "touch" && pointer.button === 0) {
        setPress({ held: true, on: current.current })
      }
    }
    // Anywhere: the drag may end outside the text.
    const onUp = () =>
      setPress((now) => (now.held ? { ...now, held: false } : now))
    target.addEventListener("pointerdown", onDown)
    window.addEventListener("pointerup", onUp, true)
    window.addEventListener("pointercancel", onUp, true)
    return () => {
      target.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointerup", onUp, true)
      window.removeEventListener("pointercancel", onUp, true)
      setPress(NO_MOUSE_PRESS)
    }
  }, [target])
  if (press.on !== null && press.on !== selection) {
    setPress({ ...press, on: null })
  }
  return press
}

interface Touches {
  /** Whether a finger is on the screen anywhere but on the bar itself. */
  down: boolean
  /** How many such touches have ended. */
  ended: number
}

const NO_TOUCHES: Touches = { down: false, ended: 0 }

/** The touches on the screen anywhere but on the bar itself. */
function useTouches(enabled: boolean): Touches {
  const [touches, setTouches] = React.useState(NO_TOUCHES)
  React.useEffect(() => {
    if (!enabled) {
      return
    }
    const onStart = (event: TouchEvent) => {
      const onBar =
        event.target instanceof Element &&
        event.target.closest(`[${BAR_ATTRIBUTE}]`) !== null
      if (!onBar) {
        setTouches((now) => (now.down ? now : { ...now, down: true }))
      }
    }
    const onEnd = (event: TouchEvent) => {
      if (event.touches.length === 0) {
        setTouches((now) =>
          now.down ? { down: false, ended: now.ended + 1 } : now
        )
      }
    }
    const options = { capture: true, passive: true }
    document.addEventListener("touchstart", onStart, options)
    document.addEventListener("touchend", onEnd, options)
    document.addEventListener("touchcancel", onEnd, options)
    return () => {
      document.removeEventListener("touchstart", onStart, options)
      document.removeEventListener("touchend", onEnd, options)
      document.removeEventListener("touchcancel", onEnd, options)
      setTouches(NO_TOUCHES)
    }
  }, [enabled])
  return touches
}

/**
 * How long a selection stands still on a touch screen before the bar shows.
 * A selection handle being dragged moves the selection many times a second,
 * and a drag's pauses are shorter than this; much longer and the bar feels
 * late once the finger is off.
 */
const SELECTION_BAR_SETTLE_MS = 400

/** Whether `key` has stayed the same for `SELECTION_BAR_SETTLE_MS`. */
function useSettled(key: string, enabled: boolean): boolean {
  const [settledKey, setSettledKey] = React.useState(key)
  React.useEffect(() => {
    if (!enabled) {
      return
    }
    const timer = setTimeout(() => setSettledKey(key), SELECTION_BAR_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [key, enabled])
  return settledKey === key
}

interface UseSelectionBarOptions {
  /**
   * The selection the bar is for, or null while there is none. A string that
   * changes with the selection's extent and not with its formatting (its two
   * ends), so applying a style from the bar does not count as a new selection.
   */
  selection: string | null
  /**
   * The text, where a mouse press starts a selection: the bar waits for the
   * button's release, and stays away for a selection the press left as it
   * was. Only the text's own box, never the whole document: a press on the
   * bar would count as one too, and close it under its click.
   */
  pressTarget: HTMLElement | null
}

interface SelectionBarState {
  /** Whether the bar shows now. */
  open: boolean
  /** Whether the main pointer is a finger: pass it on to the bar. */
  touch: boolean
}

/**
 * When the bar shows for `selection`. With a mouse, once the button that
 * chose the selection is up; from the keyboard, at once. On a touch screen,
 * once no finger is down (a press on the bar itself aside) and both the
 * selection and the last finger to lift have stood still for 400ms, so the
 * bar stays out of the way while a finger, or a selection handle, is still
 * choosing what to select.
 *
 * A mouse press on the text puts the bar away for the selection it went down
 * on: the bar shows again for another selection, not for that one. A click on
 * the selection clears it only once the button is up, so shown again on the
 * release, the bar would be put away a second time a moment later.
 *
 * The wait after a finger lifts holds even when the selection is unchanged,
 * for the same reason: a tap beside the selection hides the bar while the
 * finger is down, and the platform clears the selection only once the tap is
 * over. A finger that scrolled the text and left the selection where it was
 * gets the bar back once the wait is over.
 */
function useSelectionBar({
  selection,
  pressTarget,
}: UseSelectionBarOptions): SelectionBarState {
  const touch = useCoarsePointer()
  const press = useMousePress(pressTarget, selection)
  const touches = useTouches(touch)
  const settled = useSettled(`${touches.ended}:${selection ?? ""}`, touch)
  return {
    touch,
    open:
      selection !== null &&
      !press.held &&
      selection !== press.on &&
      (!touch || (!touches.down && settled)),
  }
}

/** One thing the bar or its list does. */
interface SelectionBarAction {
  id: string
  /** Shown, or with `preview`, read out by assistive technology. */
  label: string
  icon?: LucideIcon
  /**
   * On the bar, show the label beside the icon: for a bar of one or two
   * actions, where there is room for words and an icon alone says less.
   */
  showLabel?: boolean
  /** Drawn in place of the icon and label in the list: a layout's drawing. */
  preview?: React.ReactNode
  /** A toggle's state, shown as pressed; leave it out for a plain action. */
  checked?: boolean
  disabled?: boolean
  /** Drawn as a destructive action. */
  destructive?: boolean
  onSelect: () => void
}

/** A group in the list: its actions in runs, a separator between runs. */
interface SelectionBarGroup {
  id: string
  label: string
  icon: LucideIcon
  runs: SelectionBarAction[][]
}

type SelectionBarEntry = SelectionBarAction | SelectionBarGroup

/** The whole list: entries in runs, a separator between runs. */
type SelectionBarMenu = SelectionBarEntry[][]

function isGroup(entry: SelectionBarEntry): entry is SelectionBarGroup {
  return "runs" in entry
}

/**
 * Below the selection on a touch screen, by the room the platforms' selection
 * handles take under the text (Android's teardrop is about 22px tall), so the
 * bar never covers one.
 */
const SELECTION_BAR_BELOW_HANDLES = 28

/**
 * Above the selection on a touch screen, where there is no room below it (a
 * chat's composer, above the keyboard): far enough up to clear the platform's
 * own selection menu, which takes the room just above the text. Android's,
 * Material's text selection toolbar, is 48dp tall about 8dp above the text;
 * this leaves 8px between it and the bar.
 */
const SELECTION_BAR_ABOVE_CALLOUT = 64

function touchOffset({ side }: { side: string }) {
  return side === "top"
    ? SELECTION_BAR_ABOVE_CALLOUT
    : SELECTION_BAR_BELOW_HANDLES
}

// A press on the bar would otherwise take focus from the text, and on a phone
// the keyboard with it.
const keepFocus = (event: React.MouseEvent) => event.preventDefault()

// 44px for a finger, the smaller of the platforms' minimum targets (44pt on
// iOS, 48dp on Android).
const TOUCH_TARGET = "min-h-11 min-w-11"

interface SelectionBarButtonProps {
  icon: LucideIcon
  /**
   * Names the button for assistive technology; shown as its tooltip, or
   * beside the icon with `showLabel`.
   */
  label: string
  showLabel?: boolean
  /** A toggle's state, shown as pressed; leave it out for a plain action. */
  pressed?: boolean
  /** For a button that opens more: whether it has. */
  expanded?: boolean
  disabled?: boolean
  touch: boolean
  onClick: () => void
}

/** One of the bar's buttons, drawn by its icon, and its label when shown. */
function SelectionBarButton({
  icon: Icon,
  label,
  showLabel = false,
  pressed,
  expanded,
  disabled,
  touch,
  onClick,
}: SelectionBarButtonProps) {
  // The same height either way: `sm` and `lg` are `icon-sm` and `icon-lg`'s.
  const size = showLabel ? (touch ? "lg" : "sm") : touch ? "icon-lg" : "icon-sm"
  return (
    <Button
      type="button"
      data-slot="selection-bar-button"
      variant={pressed ? "secondary" : "ghost"}
      size={size}
      className={touch ? TOUCH_TARGET : undefined}
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      title={showLabel ? undefined : label}
      disabled={disabled}
      onClick={onClick}
    >
      {showLabel ? (
        <>
          <Icon data-icon="inline-start" />
          {label}
        </>
      ) : (
        <Icon />
      )}
    </Button>
  )
}

interface RowProps {
  label: string
  icon?: LucideIcon
  /** Drawn in place of the icon and label, which is then read out only. */
  preview?: React.ReactNode
  /** What the row ends with: a check, or the way into a group. */
  trailing?: React.ReactNode
  pressed?: boolean
  disabled?: boolean
  destructive?: boolean
  touch: boolean
  onClick: () => void
}

/** One row of the list `⋮` turns the bar into. */
function Row({
  label,
  icon: Icon,
  preview,
  trailing,
  pressed,
  disabled,
  destructive,
  touch,
  onClick,
}: RowProps) {
  return (
    <Button
      type="button"
      data-slot="selection-bar-row"
      variant={destructive ? "destructive" : "ghost"}
      size="sm"
      className={cn("w-full justify-start font-normal", touch && "min-h-11")}
      aria-label={preview ? label : undefined}
      title={preview ? label : undefined}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {preview ?? (
        <>
          {Icon ? <Icon /> : null}
          {label}
        </>
      )}
      {trailing ? <span className="ml-auto">{trailing}</span> : null}
    </Button>
  )
}

function Runs<T>({
  runs,
  render,
}: {
  runs: T[][]
  render: (entry: T) => React.ReactNode
}) {
  return runs
    .filter((run) => run.length > 0)
    .map((run, index) => (
      // Runs are fixed lists, so their position is their identity.
      <React.Fragment key={index}>
        {index > 0 ? <Separator className="my-0.5" /> : null}
        {run.map(render)}
      </React.Fragment>
    ))
}

/** What the bar sits against: a box the host measures around the selection. */
type SelectionBarAnchor = PopoverPrimitive.Positioner.Props["anchor"]

type Side = NonNullable<PopoverPrimitive.Positioner.Props["side"]>

const SIDES: readonly string[] = [
  "top",
  "bottom",
  "left",
  "right",
  "inline-start",
  "inline-end",
] satisfies Side[]

function isSide(value: string | null | undefined): value is Side {
  return value != null && SIDES.includes(value)
}

/**
 * The list stays on the side of the selection the bar was on, and grows away
 * from the selection from the bar's near edge: down from the bar's top below
 * the selection, up from its bottom above it. The other side, and the
 * selection itself, belong to the platform's own selection menu, which is
 * drawn over the page, so a list there would have rows no finger can reach.
 * When the list is longer than the room on its side, it scrolls.
 */
const LIST_COLLISION_AVOIDANCE = {
  side: "none",
  fallbackAxisSide: "none",
} as const

interface SelectionBarProps {
  /** From `useSelectionBar`. */
  open: boolean
  anchor: SelectionBarAnchor
  /** The bar's own buttons, drawn by their icons: the actions used most. */
  actions: SelectionBarAction[]
  /**
   * What `⋮` lists: everything the bar's own buttons don't do, none of them
   * again. No `⋮` without it.
   */
  more?: SelectionBarMenu
  /** From `useSelectionBar`: sizes and places the bar for a finger. */
  touch?: boolean
  /**
   * Whether `⋮` has turned the bar into its list, for a host that closes the
   * list itself (on Escape, say). Left out, the bar keeps it.
   */
  moreOpen?: boolean
  onMoreOpenChange?: (open: boolean) => void
  /** Names the bar for assistive technology. */
  label?: string
}

/**
 * The bar: a compact row of buttons beside the selection, each drawn by its
 * icon and named by its label, with a toggle's state shown as pressed; then
 * `⋮`, which turns the bar into a list of the rest, in place. A group opens in
 * the same list, with a row back out of it, and a choice turns the list back
 * into the bar. No press in the bar or the list takes focus, so the text
 * keeps its focus and its selection, and a phone its keyboard.
 *
 * With a mouse it sits above the selection. On a touch screen it sits below,
 * clear of the handles, because the platform's own selection menu, with its
 * spelling replacements, takes the room above; where there is no room below
 * it goes above, clear of that menu. Buttons and rows are then at least 44px.
 * The list stays on the bar's side of the selection, growing away from it
 * from the bar's near edge, and scrolls when it is longer than the room there.
 */
function SelectionBar({
  open,
  anchor,
  actions,
  more = [],
  touch = false,
  moreOpen: moreOpenProp,
  onMoreOpenChange,
  label = "Selection",
}: SelectionBarProps) {
  const [ownMoreOpen, setOwnMoreOpen] = React.useState(false)
  const moreOpen = moreOpenProp ?? ownMoreOpen
  const setMoreOpen = (next: boolean) => {
    setOwnMoreOpen(next)
    onMoreOpenChange?.(next)
  }
  const [groupId, setGroupId] = React.useState<string | null>(null)
  const popup = React.useRef<HTMLDivElement>(null)
  // Where the bar was drawn when `⋮` was pressed, which can be the other side
  // from the one asked for, where that had no room.
  const [listSide, setListSide] = React.useState<Side | null>(null)
  const barSide: Side = touch ? "bottom" : "top"
  // The list belongs to the bar it was opened from, and a group to the list.
  if (!open && ownMoreOpen) {
    setOwnMoreOpen(false)
  }
  if (!moreOpen && groupId !== null) {
    setGroupId(null)
  }
  // A group can leave the list while it is open (a table's, once the
  // selection leaves the table); the list then shows from its top.
  const group = more
    .flat()
    .find(
      (entry): entry is SelectionBarGroup =>
        isGroup(entry) && entry.id === groupId
    )
  const hasMore = more.some((run) => run.length > 0)
  const actionRow = (action: SelectionBarAction) => (
    <Row
      key={action.id}
      label={action.label}
      icon={action.icon}
      preview={action.preview}
      trailing={action.checked ? <CheckIcon /> : undefined}
      pressed={action.checked}
      disabled={action.disabled}
      destructive={action.destructive}
      touch={touch}
      onClick={() => {
        setMoreOpen(false)
        action.onSelect()
      }}
    />
  )

  return (
    <Popover open={open}>
      <PopoverContent
        ref={popup}
        anchor={anchor}
        side={moreOpen ? (listSide ?? barSide) : barSide}
        collisionAvoidance={moreOpen ? LIST_COLLISION_AVOIDANCE : undefined}
        sideOffset={touch ? touchOffset : undefined}
        initialFocus={false}
        finalFocus={false}
        aria-label={label}
        data-slot="selection-bar"
        {...{ [BAR_ATTRIBUTE]: "" }}
        onMouseDown={keepFocus}
        className={cn(
          "w-auto gap-0.5 p-1",
          moreOpen
            ? "max-h-(--available-height) min-w-56 overflow-y-auto"
            : "flex-row"
        )}
      >
        {!moreOpen ? (
          <>
            {actions.map((action) => (
              <SelectionBarButton
                key={action.id}
                icon={action.icon ?? EllipsisIcon}
                label={action.label}
                showLabel={action.showLabel}
                pressed={action.checked}
                disabled={action.disabled}
                touch={touch}
                onClick={action.onSelect}
              />
            ))}
            {hasMore ? (
              <SelectionBarButton
                icon={EllipsisVerticalIcon}
                label="More"
                expanded={false}
                touch={touch}
                onClick={() => {
                  const drawn = popup.current?.getAttribute("data-side")
                  setListSide(isSide(drawn) ? drawn : null)
                  setMoreOpen(true)
                }}
              />
            ) : null}
          </>
        ) : group ? (
          <>
            <Row
              label="Back"
              icon={ChevronLeftIcon}
              touch={touch}
              onClick={() => setGroupId(null)}
            />
            <Separator className="my-0.5" />
            <Runs runs={group.runs} render={actionRow} />
          </>
        ) : (
          <Runs
            runs={more}
            render={(entry) =>
              isGroup(entry) ? (
                <Row
                  key={entry.id}
                  label={entry.label}
                  icon={entry.icon}
                  trailing={<ChevronRightIcon />}
                  touch={touch}
                  onClick={() => setGroupId(entry.id)}
                />
              ) : (
                actionRow(entry)
              )
            }
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

export {
  SelectionBar,
  useSelectionBar,
  useCoarsePointer,
  SELECTION_BAR_SETTLE_MS,
  SELECTION_BAR_BELOW_HANDLES,
  SELECTION_BAR_ABOVE_CALLOUT,
  type SelectionBarProps,
  type SelectionBarAction,
  type SelectionBarGroup,
  type SelectionBarEntry,
  type SelectionBarMenu,
  type SelectionBarAnchor,
}
