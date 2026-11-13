import { ChevronRight, Ellipsis } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

import { Button } from '../button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../dropdown-menu'
import { cn } from 'cn'

export interface GraphPathSegment {
  id: string
  label: string
}

export interface GraphPathProps {
  /** The levels from the top: the graph first, the open level last. */
  segments: GraphPathSegment[]
  /** Pressing a segment before the last: the host opens that level. */
  onOpen: (id: string) => void
  className?: string
}

// A segment the pointer presses: at least 44 px tall on a coarse pointer, so
// a finger reaches it, and the button's own height elsewhere.
const SEGMENT = 'max-w-48 min-w-0 pointer-coarse:h-11'

// Where an open canvas is in its graph, as a row of segments. Every segment but
// the last is a button back to its level; the last is the open level, marked
// current and not pressable.
//
// When the row is wider than its box, the segments between the first and the
// last fold, one at a time from the front, behind an ellipsis that opens them
// as a menu. How many fold is measured, not guessed: after each render that
// still overflows one more folds, before the browser paints, and a change of
// width unfolds them all to measure again.
export function GraphPath({ segments, onOpen, className }: GraphPathProps) {
  const listRef = useRef<HTMLOListElement>(null)
  const [folded, setFolded] = useState(0)
  const middle = segments.slice(1, -1)
  const key = segments.map((s) => `${s.id}:${s.label}`).join('|')

  // biome-ignore lint/correctness/useExhaustiveDependencies: key is only a re-run trigger: new segments are measured from nothing folded
  useLayoutEffect(() => {
    setFolded(0)
  }, [key])

  useLayoutEffect(() => {
    const list = listRef.current
    if (list && list.scrollWidth > list.clientWidth && folded < middle.length) {
      setFolded(folded + 1)
    }
  })

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) {
      return undefined
    }
    let width = list.clientWidth
    const observer = new ResizeObserver(() => {
      if (list.clientWidth !== width) {
        width = list.clientWidth
        setFolded(0)
      }
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  if (segments.length === 0) {
    return null
  }
  const [first] = segments
  const last = segments[segments.length - 1]
  const hidden = middle.slice(0, folded)
  const shown = middle.slice(folded)

  return (
    <nav aria-label='Path' className={cn('min-w-0', className)}>
      <ol ref={listRef} className='flex min-w-0 items-center gap-0.5 overflow-hidden'>
        {segments.length > 1 ? (
          <li className='flex min-w-0 shrink items-center'>
            <Button variant='ghost' size='sm' className={SEGMENT} onClick={() => onOpen(first.id)}>
              <span className='truncate'>{first.label}</span>
            </Button>
          </li>
        ) : null}
        {hidden.length > 0 ? (
          <li className='flex shrink-0 items-center'>
            <Separator />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant='ghost' size='icon-sm' className='pointer-coarse:size-11' aria-label='More levels' />}
              >
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align='start'>
                {hidden.map((segment) => (
                  <DropdownMenuItem key={segment.id} onClick={() => onOpen(segment.id)}>
                    {segment.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ) : null}
        {shown.map((segment) => (
          <li key={segment.id} className='flex min-w-0 shrink items-center'>
            <Separator />
            <Button variant='ghost' size='sm' className={SEGMENT} onClick={() => onOpen(segment.id)}>
              <span className='truncate'>{segment.label}</span>
            </Button>
          </li>
        ))}
        <li className='flex min-w-0 shrink items-center'>
          {segments.length > 1 ? <Separator /> : null}
          <span
            aria-current='page'
            className='flex h-8 min-w-0 max-w-48 items-center px-2.5 text-sm font-medium pointer-coarse:h-11'
          >
            <span className='truncate'>{last.label}</span>
          </span>
        </li>
      </ol>
    </nav>
  )
}

function Separator() {
  return <ChevronRight aria-hidden className='size-3.5 shrink-0 text-muted-foreground' />
}
