'use client';

import { ChevronRight } from "lucide-react";
import { ReactNode, useState } from "react";

import { StickySection } from "@/components/experimental/sticky-section";
import { Flex, type FlexProps } from "@/components/ui/layout/flex";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export interface ChatAreaProps {
  fromEnd?: boolean
  children?: ReactNode
  className?: string
}

export function ChatArea({ fromEnd, children, className }: ChatAreaProps) {
  return (
    <ScrollArea
      className={cn(
        'flex-1',
        '[&_[data-radix-scroll-area-viewport]>div]:!flex',
        '[&_[data-radix-scroll-area-viewport]>div]:!flex-col',
        '[&_[data-radix-scroll-area-viewport]>div]:!min-h-full',
        className
      )}
    >
      {children}
    </ScrollArea>
  );
}

export interface ChatContentProps extends FlexProps {
  compact: boolean
}

export function ChatContent({ compact, className, children, ...props }: ChatContentProps) {
  return (
    <Flex expanded justify='end'>
      <Flex withSpacing {...props} className={cn(
        compact && 'w-full max-w-6xl mx-auto',
        className
      )}>{children}</Flex>
    </Flex>
  );
}

export interface ChatHeaderProps extends FlexProps {
  compact?: boolean
  fade?: boolean
}

export function ChatHeader({ compact, fade, className, children, ...props }: ChatBarProps) {
  return (
    <StickySection side='top' fade={fade}>
      <Flex withGaps withPadding {...props} className={cn(
        compact && 'max-w-3xl mx-auto',
        'w-full',
        className
      )}>
        {children}
      </Flex>
    </StickySection>
  );
}

export interface ChatBarProps extends FlexProps {
  compact?: boolean
  fade?: boolean
}

export function ChatBar({ compact, fade, className, children, ...props }: ChatBarProps) {
  return (
    <StickySection side='bottom' fade={fade}>
      <Flex withGaps withPadding {...props} className={cn(
        compact && 'max-w-3xl mx-auto',
        'w-full',
        className
      )}>
        {children}
      </Flex>
    </StickySection>
  );
}

export interface ChatSidebarProps {
  children: ReactNode
}

export function ChatSidebar({ children }: ChatSidebarProps) {
  return (
    <ScrollArea className='h-full w-64 border-r shrink-0'>
      <Flex className='p-1 gap-1'>{children}</Flex>
    </ScrollArea>
  );
}

function ChatToolRow({ label, children }: { label: string, children: ReactNode }) {
  return (
    <Flex row className='gap-3 px-3 py-2'>
      <div className='w-14 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground pt-0.5'>
        {label}
      </div>
      <div className='flex-1 min-w-0'>{children}</div>
    </Flex>
  );
}

export interface ChatToolProps {
  name: string
  description?: string
  args: unknown
  result?: { text: string, isError?: boolean }
}

export function ChatTool({ name, description, args, result }: ChatToolProps) {
  const isError = result?.isError === true;
  const [open, setOpen] = useState(false);
  return (
    <Flex className='gap-1.5'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex items-center gap-2 text-xs text-left cursor-pointer'
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className='font-mono font-medium shrink-0'>{name}</span>
        {description && (
          <span className='font-mono text-muted-foreground'>{description}</span>
        )}
        {!result && <span className='text-muted-foreground shrink-0'>running…</span>}
        {isError && <span className='text-destructive shrink-0'>error</span>}
      </button>
      {open && (
        <div className={cn(
          'rounded-md border bg-muted/30 text-xs overflow-hidden',
          isError && 'border-destructive/60',
        )}>
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
  );
}
