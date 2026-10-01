'use client'

import { FileText, X } from 'lucide-react'
import type { PointerEventHandler, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from 'ui/components/ui/resizable'
import { cn } from 'cn'

import { BackButton } from '../utils/back-button'
import { type Artifact, ArtifactBody, ArtifactTitle } from './thread-artifacts'

// Side by side, each pane is at least a phone's width, px: two columns are only
// worth drawing when each could stand on its own as a screen. Also the
// narrowest either side can be dragged to while split.
export const SPLIT_PANE_MIN_WIDTH = 375
// The divider between them: the resizable handle is a one-pixel rule.
export const SPLIT_DIVIDER_WIDTH = 1
// 48rem -- Tailwind's `@3xl` container step, the first one that holds two
// phone-width panes and the divider (751 px); the step below, `@2xl` at 42rem,
// does not. On a step rather than at 751 so the line falls where a container
// query written against the same scale would. Below it the note takes the
// conversation's place instead.
export const ARTIFACT_SPLIT_MIN_WIDTH = 768

/** Whether a container this wide holds the conversation and a note side by side. */
export function splitFits(width: number): boolean {
  return width >= ARTIFACT_SPLIT_MIN_WIDTH
}

// Every pane's header row, the conversation's and the note's alike. The host's
// `headerClassName` adds the height and padding, and one class for both is what
// keeps the two rows the same height and their borders on one line across the
// divider -- by construction, not by two values that happen to agree.
const HEADER_ROW_CLASS = 'flex shrink-0 items-center gap-2 border-b border-border'

export interface ArtifactSplitProps {
  /** The conversation pane's header content -- who and where, and the
   * thread's controls. The row around it is drawn here. */
  header: ReactNode
  /** Controls that belong to the surface rather than to either pane -- a
   * window's position and close. Drawn at the end of the rightmost visible
   * header row: the conversation's while no note is open, the note's once one
   * is, so they stay in the window's corner. */
  trailing?: ReactNode
  /** Height and padding for both header rows. Give a fixed height: it is what
   * lets the two rows line up whatever each one holds. */
  headerClassName?: string
  /** A pointer pressed on either header row -- for a host whose header is
   * also a drag handle. */
  onHeaderPointerDown?: PointerEventHandler<HTMLDivElement>
  /** The size of the note's own Close, matching the header's other icon
   * controls: `icon` in a pointer header, `icon-sm` on a touch cover. */
  controlSize?: 'icon' | 'icon-sm'
  /** The conversation. Stays mounted whatever happens to the note beside it. */
  children: ReactNode
  /** The open note; absent or null leaves the conversation the whole width. */
  artifact?: Artifact | null
  /** The note was closed -- its Close beside the conversation, or its Back
   * where it covered it. Both mean the same thing: show the conversation. */
  onClose: () => void
  className?: string
}

// A conversation pane and the thread's open note, each with its own header.
// Where the container holds two phone-width panes, the note opens to the
// right of a divider the reader can drag -- the same kit handle the dock
// window's panel uses -- and its header continues the conversation's across
// it. Where it does not, the note REPLACES the conversation pane, header and
// all, and Back brings it back: a split there leaves neither side readable, and
// a note's header stacked under the conversation's would be two headers where
// the reader is looking at one thing.
//
// Measured on the container rather than the viewport, because the same
// conversation sits in a full page and in a window a third of its width, and
// only the space it actually has decides whether two columns fit. Read live,
// so resizing across the threshold rearranges without closing the note. Starts
// narrow so the server and the first client paint agree.
//
// ONE tree for both arrangements, and that is the point of this component. The
// conversation holds a live session, a scroll position and a half-written
// draft; an arrangement that rendered it in a different parent would remount
// it and drop all three every time the width crossed the line. So the narrow
// arrangement is the wide one with the conversation pane and the divider
// hidden. The panels grow from a zero basis, so the note -- the one panel left
// visible -- fills the group on its own. Only the surface's `trailing` controls
// move between the rows; they hold nothing a remount would lose.
//
// Hidden through the `hidden` attribute rather than a class, because a panel's
// className lands on its inner element and its outer one carries an inline
// `display: flex`; the stylesheet's `[hidden]` rule is `!important` and wins.
export function ArtifactSplit({
  header,
  trailing,
  headerClassName,
  onHeaderPointerDown,
  controlSize = 'icon',
  children,
  artifact,
  onClose,
  className,
}: ArtifactSplitProps) {
  const groupRef = useRef<HTMLDivElement | null>(null)
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const element = groupRef.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setWide(splitFits(entry.contentRect.width))
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const open = artifact ?? null
  const inPlace = open !== null && !wide
  // The minimums are pixels, and only where the split is drawn. The panels
  // take them as `px` strings; a bare string would be read as a percentage.
  // Narrow, one side is hidden and the other fills the group, and a pixel
  // minimum measured against a group narrower than both would only fight that.
  const conversationMin = wide ? `${SPLIT_PANE_MIN_WIDTH}px` : undefined
  const artifactMin = wide ? `${SPLIT_PANE_MIN_WIDTH}px` : undefined
  const rowClass = cn(HEADER_ROW_CLASS, headerClassName)

  return (
    <ResizablePanelGroup elementRef={groupRef} className={cn('min-h-0', className)}>
      {/* `id` on both, because the note's panel comes and goes: without stable
          identities the group cannot tell an added panel from a rearranged
          one, and re-lays-out from scratch each time. */}
      <ResizablePanel
        id='conversation'
        hidden={inPlace}
        defaultSize={open ? '68%' : '100%'}
        minSize={conversationMin}
        className='flex min-w-0 flex-col'
      >
        <div data-slot='artifact-split-header' className={rowClass} onPointerDown={onHeaderPointerDown}>
          {header}
          {open ? null : trailing}
        </div>
        <div className='flex min-h-0 flex-1 flex-col'>{children}</div>
      </ResizablePanel>
      {open ? (
        <>
          {/* `withHandle` so the grip is drawn rather than left as a hit area
              to discover; it runs the full height, headers included, because
              the two headers are one line broken by it. Disabled as well as
              hidden while the note covers the conversation, so the keyboard
              cannot resize a panel nobody sees. */}
          <ResizableHandle withHandle hidden={!wide} disabled={!wide} />
          <ResizablePanel id='artifact' defaultSize='32%' minSize={artifactMin} className='flex min-w-0 flex-col'>
            <div data-slot='artifact-split-header' className={rowClass} onPointerDown={onHeaderPointerDown}>
              {/* Back leads where the note covers the conversation -- the way
                  out of a covering screen; beside it, the note's glyph leads
                  and Close ends it. The same action, named for where the
                  reader is. Grouped with the title at a gap of its own, so a
                  host that packs its row's controls tight does not pack the
                  glyph against the name. */}
              <div className='flex min-w-0 flex-1 items-center gap-2'>
                {wide ? (
                  <FileText className='size-4 shrink-0 text-muted-foreground' />
                ) : (
                  <BackButton onClick={onClose} />
                )}
                <ArtifactTitle artifact={open} className='flex-1' />
              </div>
              {wide ? (
                <Button
                  type='button'
                  size={controlSize}
                  variant='ghost'
                  aria-label='Close'
                  title='Close'
                  onClick={onClose}
                  className='shrink-0'
                >
                  <X />
                </Button>
              ) : null}
              {trailing}
            </div>
            <ArtifactBody artifact={open} />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  )
}
