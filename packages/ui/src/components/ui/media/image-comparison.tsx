import { Slider as SliderPrimitive } from '@base-ui/react/slider'
import { ChevronsLeftRight, CircleAlert, Images, LoaderCircle } from 'lucide-react'
import {
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
  useState,
  useSyncExternalStore,
} from 'react'

import { cn } from 'cn'
import { Alert, AlertDescription, AlertTitle } from '../alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from 'ui/components/ui/empty'

// A pointer that hovers and aims finely (a mouse, a trackpad): the divider follows it across the
// frame without a press. Without one the handle is dragged instead.
const HOVER_POINTER = '(hover: hover) and (pointer: fine)'

function subscribeToHoverPointer(onChange: () => void) {
  const query = window.matchMedia(HOVER_POINTER)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function useHoverPointer() {
  return useSyncExternalStore(
    subscribeToHoverPointer,
    () => window.matchMedia(HOVER_POINTER).matches,
    // The server renders the dragged handle; a browser with a hovering pointer follows it once hydrated.
    () => false,
  )
}

export interface ImageComparisonSide {
  /** Image address. Unset while the image has not arrived. */
  src?: string
  /** Text alternative of the image. */
  alt: string
  /** Short name of this side: its caption in its top corner, truncated to stay inside its half. */
  label?: string
  /**
   * Why this side's image will not come, such as a file that could not be read. Ignored while the side
   * has a `src`. Shown under `label` at the foot of the frame, over the other side's image.
   */
  error?: ReactNode
}

export type ImageComparisonProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The image shown left of the divider. Left out when there is no such image to come. */
  before?: ImageComparisonSide
  /** The image shown right of the divider. Left out when there is no such image to come. */
  after?: ImageComparisonSide
  /**
   * The images are on their way: while a side has no `src`, the frame shows a loader with how many
   * of the sides have arrived, instead of the one that has or the empty state. Ignored once every
   * side has arrived.
   */
  loading?: boolean
  /** Text under the loader's count, saying what is being waited for. Unset shows the count alone. */
  loadingLabel?: ReactNode
  /** Icon of the empty state; `null` shows none. */
  emptyIcon?: ReactNode
  /** Heading of the empty state. */
  emptyTitle?: ReactNode
  /** Text under the empty state's heading, such as how to get images to compare. */
  emptyDescription?: ReactNode
  /** Where the divider starts each time the comparison appears, in percent of the width from the left edge. */
  defaultPosition?: number
  /**
   * Width over height of the frame, the same in every state. Unset follows the image that loaded
   * last, square before one has.
   */
  aspectRatio?: number
  /**
   * The frame fills its container in height as well as width, instead of taking its height from an
   * aspect ratio: for a container with a size of its own, such as a resizable panel or window. The
   * images are letterboxed inside it as ever, and `aspectRatio` is ignored.
   */
  fill?: boolean
  /** Accessible name of the divider's handle. */
  handleLabel?: string
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value))
}

// Leaves a part out rather than rendering an empty box that would still take its gap.
function isShown(node: ReactNode) {
  return node != null && node !== false && node !== ''
}

interface ComparisonStatusProps {
  icon?: ReactNode
  title?: ReactNode
  description?: ReactNode
  /** `status` for content that changes by itself, so assistive technology announces the change. */
  role?: 'status'
}

// The frame's content while there is no image to show: laid over the whole frame, centred, with
// long words broken so caller text wraps inside the frame; what still does not fit is clipped.
function ComparisonStatus({ icon, title, description, role }: ComparisonStatusProps) {
  return (
    <Empty className='absolute inset-0 p-4 wrap-anywhere'>
      <EmptyHeader role={role}>
        {isShown(icon) && (
          <EmptyMedia>
            {icon}
          </EmptyMedia>
        )}
        {isShown(title) && <EmptyTitle>{title}</EmptyTitle>}
        {isShown(description) && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  )
}

type SideName = 'before' | 'after'

// Each side keeps its caption in its own corner, alone or in the comparison, so it does not move
// when the other side arrives.
const CAPTION_CORNER: Record<SideName, string> = {
  before: 'left-2',
  after: 'right-2',
}

interface ShownSide {
  name: SideName
  side: ImageComparisonSide
}

// The sides given, `before` first.
function getShownSides(before: ImageComparisonSide | undefined, after: ImageComparisonSide | undefined): ShownSide[] {
  const shown: ShownSide[] = []
  if (before) shown.push({ name: 'before', side: before })
  if (after) shown.push({ name: 'after', side: after })
  return shown
}

interface SideImageProps extends ShownSide {
  /** The visible span of the side, in percent of the width from the left edge. Unset shows all of it. */
  span?: { from: number; to: number }
  onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => void
}

// One side drawn over the whole frame, letterboxed, with its caption. In the comparison it is
// clipped to its span, so the image keeps its place while the divider moves.
function SideImage({ name, side, span, onImageLoad }: SideImageProps) {
  return (
    <div className='absolute inset-0' style={span && { clipPath: `inset(0 ${100 - span.to}% 0 ${span.from}%)` }}>
      <img
        src={side.src}
        alt={side.alt}
        draggable={false}
        onLoad={onImageLoad}
        className='block size-full object-contain'
      />
      {side.label && (
        <span
          className={cn(
            'absolute top-2 max-w-[45%] truncate rounded-md bg-background/80 px-2 py-0.5 text-xs font-medium text-foreground',
            CAPTION_CORNER[name],
          )}
        >
          {side.label}
        </span>
      )}
    </div>
  )
}

// Why a side has no image, laid over the foot of the frame and the other side's image. Wraps in
// full; a message longer than the frame's height scrolls inside it.
function SideError({ side }: ShownSide) {
  return (
    <Alert variant='destructive' className='absolute inset-x-2 bottom-2 w-auto max-h-[calc(100%-1rem)] overflow-y-auto px-3 py-2 wrap-anywhere'>
      <CircleAlert />
      {side.label && <AlertTitle>{side.label}</AlertTitle>}
      <AlertDescription>{side.error}</AlertDescription>
    </Alert>
  )
}

interface ComparisonSliderProps {
  before: ImageComparisonSide
  after: ImageComparisonSide
  defaultPosition: number
  handleLabel: string
  onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => void
}

// Both images and the divider between them. Mounted only once both images are there, so a pointer
// crossing any other state has no divider to move.
function ComparisonSlider({ before, after, defaultPosition, handleLabel, onImageLoad }: ComparisonSliderProps) {
  const [position, setPosition] = useState(() => clampPercent(defaultPosition))
  const followsPointer = useHoverPointer()

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!followsPointer || event.pointerType !== 'mouse') return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    setPosition(clampPercent(((event.clientX - rect.left) / rect.width) * 100))
  }

  return (
    <SliderPrimitive.Root
      value={position}
      onValueChange={setPosition}
      min={0}
      max={100}
      step={1}
      largeStep={10}
      thumbAlignment='center'
      onPointerMove={handlePointerMove}
      // The resize cursor marks what moves the divider: the whole frame where it follows the pointer,
      // the handle where the handle is dragged.
      className={cn('absolute inset-0 select-none', followsPointer && 'cursor-ew-resize')}
    >
      <SideImage name='after' side={after} span={{ from: position, to: 100 }} onImageLoad={onImageLoad} />
      <SideImage name='before' side={before} span={{ from: 0, to: position }} onImageLoad={onImageLoad} />
      <div
        aria-hidden
        className='pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-background shadow-sm'
        style={{ left: `${position}%` }}
      />
      {/* Only the handle takes pointer input, so a touch elsewhere on the frame still scrolls. */}
      <SliderPrimitive.Control className='pointer-events-none absolute inset-0'>
        <SliderPrimitive.Thumb
          aria-label={handleLabel}
          getAriaValueText={(_formatted, value) => `${Math.round(value)}%`}
          className={cn(
            'group/handle pointer-events-auto flex size-11 touch-none items-center justify-center',
            !followsPointer && 'cursor-ew-resize',
          )}
        >
          <span className='flex size-8 items-center justify-center rounded-full border bg-background text-foreground shadow-md ring-ring/50 group-has-[:focus-visible]/handle:ring-3'>
            <ChevronsLeftRight className='size-4' />
          </span>
        </SliderPrimitive.Thumb>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

/**
 * One or two images of the same subject in one frame. With both sides given, `before` shows left of
 * a vertical divider and `after` right of it. A side is left out when there is no such image to
 * come; with one side given the frame shows that side.
 *
 * A side has arrived once it has a `src`, and failed while it has none and has an `error`. Of the
 * sides given, the frame shows:
 * - when all have arrived, the one image alone (letterboxed, with its caption) or, for two, the
 *   comparison, with its handle on the divider. With a hovering pointer the divider follows the
 *   pointer across the frame, which shows a resize cursor all over; on touch the handle is dragged
 *   with a finger, while the rest of the frame scrolls the page as usual. The handle is a slider for
 *   the keyboard: arrows move it by 1%, Shift+arrows and Page keys by 10%, Home and End to the edges.
 * - else, while `loading` is set and a side has neither arrived nor failed, a spinner over the count
 *   of sides that have arrived out of the sides given (`0 / 2`, `1 / 2`, `0 / 1`), with
 *   `loadingLabel` under it.
 * - else, when one has arrived, that image alone, with the other side's `label` and `error` over its
 *   foot when that side failed.
 * - else the empty state: `emptyIcon`, `emptyTitle` and `emptyDescription`; also with no side given.
 * Only the comparison has a divider: the rest is static, nothing follows the pointer, and a touch
 * scrolls.
 *
 * The component takes the full width it is given and its height from `aspectRatio`, the same in
 * every state, or with `fill` the full height too; images are letterboxed inside it rather than
 * cropped. Loading and empty text wraps
 * inside the frame and is clipped where the frame is too small for it. Captions are truncated inside
 * their half.
 */
export function ImageComparison({
  before,
  after,
  loading = false,
  loadingLabel,
  emptyIcon = <Images />,
  emptyTitle,
  emptyDescription,
  defaultPosition = 50,
  aspectRatio,
  fill = false,
  handleLabel = 'Divider position',
  className,
  style,
  ...props
}: ImageComparisonProps) {
  // Lives above the states, so the frame keeps the last image's shape while the next one loads.
  const [loadedRatio, setLoadedRatio] = useState<number>()
  const shown = getShownSides(before, after)
  const arrived = shown.filter(({ side }) => side.src)
  const failed = shown.filter(({ side }) => !side.src && isShown(side.error))

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (naturalWidth > 0 && naturalHeight > 0) setLoadedRatio(naturalWidth / naturalHeight)
  }

  let content: ReactNode
  if (shown.length > 0 && arrived.length === shown.length) {
    content =
      shown.length === 2 ? (
        <ComparisonSlider
          before={shown[0].side}
          after={shown[1].side}
          defaultPosition={defaultPosition}
          handleLabel={handleLabel}
          onImageLoad={handleImageLoad}
        />
      ) : (
        <SideImage key={shown[0].name} {...shown[0]} onImageLoad={handleImageLoad} />
      )
  } else if (loading && arrived.length + failed.length < shown.length) {
    content = (
      <ComparisonStatus
        role='status'
        icon={<LoaderCircle className='animate-spin' />}
        title={
          <span className='tabular-nums'>
            {arrived.length} / {shown.length}
          </span>
        }
        description={loadingLabel}
      />
    )
  } else if (arrived.length === 1) {
    content = (
      <>
        <SideImage key={arrived[0].name} {...arrived[0]} onImageLoad={handleImageLoad} />
        {failed.map((side) => (
          <SideError key={side.name} {...side} />
        ))}
      </>
    )
  } else {
    content = <ComparisonStatus icon={emptyIcon} title={emptyTitle} description={emptyDescription} />
  }

  return (
    <div
      data-slot='image-comparison'
      className={cn('relative w-full min-w-0 overflow-hidden rounded-lg bg-muted', fill && 'h-full min-h-0', className)}
      style={{ aspectRatio: fill ? undefined : (aspectRatio ?? loadedRatio ?? 1), ...style }}
      {...props}
    >
      {content}
    </div>
  )
}
