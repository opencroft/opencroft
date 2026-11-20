import { Info } from 'lucide-react'
import { type ComponentType, createContext, type HTMLAttributes, type ReactNode, useContext, useRef } from 'react'
import { cn } from 'cn'

import { Badge } from 'ui/components/ui/badge'
import { Button } from './button'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

/** Draws a hint's markdown. The host passes its own renderer, so a hint reads like the rest of its markdown. */
export type FieldHintMarkdown = ComponentType<{ text: string }>

const FieldHintMarkdownContext = createContext<FieldHintMarkdown | null>(null)

/**
 * Gives every hint below it the host's markdown renderer. Without one a hint shows its text as
 * written, line breaks kept.
 */
export function FieldHintMarkdownProvider({
  markdown,
  children,
}: {
  markdown: FieldHintMarkdown
  children: ReactNode
}) {
  return <FieldHintMarkdownContext.Provider value={markdown}>{children}</FieldHintMarkdownContext.Provider>
}

function HintText({ text }: { text: string }) {
  const Markdown = useContext(FieldHintMarkdownContext)
  return Markdown ? <Markdown text={text} /> : <p className='whitespace-pre-wrap'>{text}</p>
}

// What the popover gives a trigger that the label must not get: the label is not a button, so it
// takes no role, tab stop or popup state, and a press on it keeps doing what a label does (focus
// or toggle its control) instead of toggling the hint. What stays are the pointer handlers that
// open the hint while a mouse rests on the label.
function labelTriggerProps({
  role: _role,
  tabIndex: _tabIndex,
  onClick: _onClick,
  onMouseDown: _onMouseDown,
  onKeyDown: _onKeyDown,
  onKeyUp: _onKeyUp,
  'aria-haspopup': _hasPopup,
  'aria-expanded': _expanded,
  'aria-controls': _controls,
  ...rest
}: HTMLAttributes<HTMLElement>): HTMLAttributes<HTMLElement> {
  return rest
}

export interface FieldHintProps {
  /**
   * The label the hint explains: a `FieldLabel`, a card's title, a section's toggle. With a mouse,
   * resting on it or on the mark opens the hint; a press on it keeps its own action.
   */
  children: ReactNode
  /** The name of what the hint is about, as plain text: the mark is announced as "About <about>". */
  about: string
  /** The hint, as markdown. */
  text?: string
  /** A heading over the hint, such as an attribute's name. Long words wrap inside the hint. */
  title?: ReactNode
  /** Short facts shown as monospace badges on their own row above the text, such as a type. */
  tags?: string[]
  className?: string
}

/**
 * A field's help behind a circled "i" beside its label. A mouse opens it by resting on the label or
 * the mark; on a touch screen a tap on the mark opens it and a second tap, or one outside, closes it.
 * It opens above the label, clear of the control below, and wraps to the screen's width.
 * With neither text nor tags it is the label alone.
 *
 * Help the user needs before acting (a consequence, a requirement, a format) stays visible in
 * `FieldDescription`; everything else goes here.
 */
export function FieldHint({ children, about, text, title, tags = [], className }: FieldHintProps) {
  const rowRef = useRef<HTMLSpanElement>(null)
  if (!text && tags.length === 0) {
    return children
  }
  return (
    <Popover>
      <span
        ref={rowRef}
        data-slot='field-hint'
        className={cn('inline-flex max-w-full min-w-0 items-center gap-1.5', className)}
      >
        <PopoverTrigger
          openOnHover
          nativeButton={false}
          render={(props) => <span {...labelTriggerProps(props)} />}
          className='min-w-0'
        >
          {children}
        </PopoverTrigger>
        <PopoverTrigger
          openOnHover
          render={
            <Button
              variant='ghost'
              size='icon-xs'
              shape='round'
              aria-label={`About ${about}`}
              className='shrink-0 text-muted-foreground'
            />
          }
        >
          <Info />
        </PopoverTrigger>
      </span>
      <PopoverContent
        anchor={rowRef}
        side='top'
        align='start'
        className='w-auto max-w-[min(22rem,calc(100vw-1rem))] min-w-0 gap-2 px-3 py-2 [overflow-wrap:anywhere]'
      >
        {title ? <div className='min-w-0 font-medium'>{title}</div> : null}
        {tags.length > 0 ? (
          <div className='flex min-w-0 flex-wrap gap-1'>
            {tags.map((tag) => (
              // A badge keeps to one clipped line; a long type here wraps instead of losing its end.
              <Badge key={tag} variant='outline' className='h-auto max-w-full font-mono whitespace-normal'>
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
        {text ? (
          <div className='min-w-0'>
            <HintText text={text} />
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
