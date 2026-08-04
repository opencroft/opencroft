'use client'

import { ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Flex, type FlexProps } from 'ui/layout/flex'
import { ScrollArea } from 'ui/scroll-area'

import { StickySection } from '@/components/experimental/sticky-section'
import { cn } from '@/lib/utils'

export interface ChatAreaProps {
  fromEnd?: boolean
  children?: ReactNode
  className?: string
}

export function ChatArea({ fromEnd, children, className }: ChatAreaProps) {
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
        '[&_[data-radix-scroll-area-viewport]>div]:!flex',
        '[&_[data-radix-scroll-area-viewport]>div]:!flex-col',
        '[&_[data-radix-scroll-area-viewport]>div]:!min-h-full',
        // Safari pushes scrollTop *beyond its valid range* while rubber-banding,
        // and the restore reads scrollTop — so `none` rather than `contain`,
        // which would stop chaining but leave the out-of-range reads. Also keeps
        // the top of the list from scrolling the page behind it.
        '[&_[data-radix-scroll-area-viewport]]:[overscroll-behavior:none]',
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
        '[&_[data-radix-scroll-area-viewport]]:[overflow-anchor:none]',
        className,
      )}
    >
      {children}
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

export function ChatHeader({ compact, fade, className, children, ...props }: ChatBarProps) {
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

export interface ChatSidebarProps {
  children: ReactNode
}

export function ChatSidebar({ children }: ChatSidebarProps) {
  return (
    <ScrollArea className='h-full w-64 border-r shrink-0'>
      <Flex className='p-1 gap-1'>{children}</Flex>
    </ScrollArea>
  )
}

function ChatToolRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex row className='gap-3 px-3 py-2'>
      <div className='w-14 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground pt-0.5'>{label}</div>
      <div className='flex-1 min-w-0'>{children}</div>
    </Flex>
  )
}

export interface ChatToolProps {
  name: string
  description?: string
  args: unknown
  result?: { text: string; isError?: boolean }
}

export function ChatTool({ name, description, args, result }: ChatToolProps) {
  const isError = result?.isError === true
  const [open, setOpen] = useState(false)
  return (
    <Flex className='gap-1.5'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex items-center gap-2 text-xs text-left cursor-pointer'
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className='font-mono font-medium shrink-0'>{name}</span>
        {description && <span className='font-mono text-muted-foreground'>{description}</span>}
        {!result && <span className='text-muted-foreground shrink-0'>running…</span>}
        {isError && <span className='text-destructive shrink-0'>error</span>}
      </button>
      {open && (
        <div
          className={cn('rounded-md border bg-muted/30 text-xs overflow-hidden', isError && 'border-destructive/60')}
        >
          <ChatToolRow label='args'>
            <pre className='max-h-48 overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>
              {JSON.stringify(args, null, 2)}
            </pre>
          </ChatToolRow>
          {result && (
            <>
              <div className='border-t' />
              <ChatToolRow label='output'>
                <pre className='overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>
                  {result.text}
                </pre>
              </ChatToolRow>
            </>
          )}
        </div>
      )}
    </Flex>
  )
}
