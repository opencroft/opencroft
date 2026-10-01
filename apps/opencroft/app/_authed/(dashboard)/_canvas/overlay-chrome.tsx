'use client'

// The canvas overlay's layout: the scrolling area the published content slot
// paints into, with a sticky header above it and a sticky bar below. Used by
// every overlay mode — search, find, and extension command modes — and by
// nothing else, which is why it sits beside the overlay rather than in a
// shared component directory. The `Chat*` names are older than the modes that
// use them today.

import { cn } from 'cn'
import type { ReactNode } from 'react'
import { Flex, type FlexProps } from 'ui/layout/flex'
import { StickySection } from 'ui/layouts/sticky-section'
import { ScrollArea } from 'ui/scroll-area'

export interface ChatAreaProps {
  children?: ReactNode
  className?: string
}

export function ChatArea({ children, className }: ChatAreaProps) {
  return (
    <ScrollArea
      className={cn(
        // `min-w-0` is not decoration here, it is the other half of `flex-1`.
        // This is laid out as a row item, so its automatic minimum size is its
        // content's min-content width — and content is caller-provided, so one
        // unbreakable token (a URL, a path, a long word) sets that floor and the
        // box refuses to shrink below it however narrow the screen gets.
        // Measured before this line existed: 784px against a 360px viewport.
        //
        // Nothing further down can rescue it. Every descendant already clears
        // its own minimum correctly; they were simply dividing up a box that
        // was too wide before they were consulted, which is why the truncation
        // they ask for looked present and did nothing.
        //
        // A scroll container is also the one place this belongs: overflow is
        // its whole purpose, so being sized BY its content is a contradiction —
        // it grows instead of scrolling.
        'flex-1 min-w-0',
        // Safari pushes scrollTop *beyond its valid range* while rubber-banding,
        // and the restore reads scrollTop — so `none` rather than `contain`,
        // which would stop chaining but leave the out-of-range reads. Also keeps
        // the top of the list from scrolling the page behind it.
        '[&_[data-slot=scroll-area-viewport]]:[overscroll-behavior:none]',
        // Own the scroll correction outright. Chrome and Firefox implement CSS
        // scroll anchoring and shift scrollTop themselves when content is
        // inserted above the anchor node — on top of the shift we apply, which
        // is why loading older messages jumps the view down.
        //
        // Not "sometimes". Measured directly: three
        // prepends in one session compensated FULLY (1578 of 1578px), NOT AT
        // ALL (0 of 1630px), and PARTIALLY (10 of 21px). The spec suppresses
        // the adjustment at scroll offset zero and on property changes to the
        // anchor's ancestors, so the same code behaves differently by position.
        //
        // The partial reading is why this is `none` rather than detect-and-
        // skip: there is no "did the browser act" bit to branch on, and
        // subtracting a measured fraction means racing a heuristic every frame.
        // Every surveyed client (Element, Signal, Telegram, Zulip, Mattermost,
        // Rocket.Chat) disables it and corrects manually, for this reason.
        //
        // Also forward cover: Safari has announced anchoring for 27, which
        // would otherwise change this component's behaviour without us touching
        // it.
        '[&_[data-slot=scroll-area-viewport]]:[overflow-anchor:none]',
        className,
      )}
    >
      {/* The viewport renders its children directly, so the filling flex
          column the content lays out in is this wrapper: a short list still
          spans the whole height, and the sticky bars have it to pin against. */}
      <div className='flex min-h-full flex-col'>{children}</div>
    </ScrollArea>
  )
}

export interface ChatContentProps extends FlexProps {
  compact: boolean
}

export function ChatContent({ compact, className, children, ...props }: ChatContentProps) {
  return (
    <Flex expanded justify='end'>
      <Flex withSpacing {...props} className={cn(compact && 'w-full max-w-6xl mx-auto', className)}>
        {children}
      </Flex>
    </Flex>
  )
}

export interface ChatHeaderProps extends FlexProps {
  compact?: boolean
  fade?: boolean
}

export function ChatHeader({ compact, fade, className, children, ...props }: ChatHeaderProps) {
  return (
    <StickySection side='top' fade={fade}>
      <Flex withGaps withPadding {...props} className={cn(compact && 'max-w-3xl mx-auto', 'w-full', className)}>
        {children}
      </Flex>
    </StickySection>
  )
}

export interface ChatBarProps extends FlexProps {
  compact?: boolean
  fade?: boolean
}

export function ChatBar({ compact, fade, className, children, ...props }: ChatBarProps) {
  return (
    <StickySection side='bottom' fade={fade}>
      <Flex withGaps withPadding {...props} className={cn(compact && 'max-w-3xl mx-auto', 'w-full', className)}>
        {children}
      </Flex>
    </StickySection>
  )
}
