import { Ellipsis, PanelLeft } from 'lucide-react'
import {
  type ComponentProps,
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { BackButton } from '../utils/back-button'
import { Button } from 'ui/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from 'ui/components/ui/dropdown-menu'
import { cn } from 'cn'

export interface TitleBarProps extends Omit<ComponentProps<'header'>, 'title'> {
  /** The product mark, as a link home. Sits right after the sidebar button. */
  brand?: ReactNode
  /**
   * A smaller mark drawn instead of `brand` on a phone, since a truncated
   * wordmark is not a smaller one. "Phone" is the viewport under 768px, the
   * same line the app's useIsMobile draws, not the bar's own width.
   */
  brandCompact?: ReactNode
  /** Where the page is: one or more switchers, divided by TitleBarSeparator. Follows the brand. */
  context?: ReactNode
  /** A heading for a surface that needs one, such as a nested screen. */
  title?: ReactNode
  /** Shows the sidebar button. */
  onMenu?: () => void
  /** Shows the back button, for a surface nested inside another. */
  onBack?: () => void
  /** The page's actions, usually TitleBarActions. A page deeper in the tree sends them through TitleBarPortal instead. */
  actions?: ReactNode
  /** Controls that belong to the app rather than the page, such as the account menu. */
  trailing?: ReactNode
  /**
   * A second row under the bar, for the page's tools. A page deeper in the tree
   * sends it through TitleBarToolbar instead. The row is drawn only while it
   * has content.
   */
  toolbar?: ReactNode
}

// Sizes are measured against the bar's own width, not the viewport's, so the
// bar folds the same way inside a split pane as it does on a phone. Targets
// grow on a coarse pointer so every control is finger-sized.
const ICON_BUTTON = 'size-8 shrink-0 pointer-coarse:size-10'

// The brand usually arrives wrapped in an inline link, whose line box would
// sit the mark above the row's centre. Flexing the direct child centres it on
// the same axis as the buttons around it.
const BRAND = 'flex h-8 shrink-0 items-center px-1 leading-none *:flex *:items-center'

export function TitleBarIconButton({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button type='button' variant='ghost' size='icon' className={cn(ICON_BUTTON, className)} {...props} />
}

// Actions are declared once and drawn twice: as buttons on a wide bar and as
// items in the overflow menu on a narrow one. Each action reads which of the
// two it is being drawn as, so a page never describes its actions as data.
const InOverflowMenu = createContext(false)

export function TitleBarActions({ children }: { children: ReactNode }) {
  return (
    <>
      <div className='hidden shrink-0 items-center gap-1 @2xl/title-bar:flex'>{children}</div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<TitleBarIconButton aria-label='More actions' className='@2xl/title-bar:hidden' />}>
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <InOverflowMenu.Provider value={true}>{children}</InOverflowMenu.Provider>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

export interface TitleBarActionProps {
  children: ReactNode
  icon?: ComponentType<{ className?: string }>
  onSelect?: () => void
  disabled?: boolean
}

export function TitleBarAction({ children, icon: Icon, onSelect, disabled }: TitleBarActionProps) {
  const inMenu = useContext(InOverflowMenu)
  const glyph = Icon && <Icon className='size-4' />

  if (inMenu) {
    return (
      <DropdownMenuItem disabled={disabled} onClick={onSelect}>
        {glyph}
        {children}
      </DropdownMenuItem>
    )
  }
  return (
    <Button type='button' variant='ghost' size='sm' disabled={disabled} onClick={onSelect}>
      {glyph}
      {children}
    </Button>
  )
}

// A page usually sits far below the shell that draws the bar. Rather than
// lifting its actions and tools into shared state, the page renders them
// where it is and they are portalled into the bar: they stay the page's own
// elements, so they re-render with the page's state and unmount with the page.
type Slot = 'title' | 'actions' | 'toolbar'

interface TitleBarSlots {
  targets: Record<Slot, HTMLElement | null>
  register: (slot: Slot, node: HTMLElement | null) => void
}

const TitleBarSlotsContext = createContext<TitleBarSlots | null>(null)

export function TitleBarProvider({ children }: { children: ReactNode }) {
  const [targets, setTargets] = useState<TitleBarSlots['targets']>({ title: null, actions: null, toolbar: null })
  const register = useCallback((slot: Slot, node: HTMLElement | null) => {
    setTargets((current) => (current[slot] === node ? current : { ...current, [slot]: node }))
  }, [])
  const value = useMemo(() => ({ targets, register }), [targets, register])
  return <TitleBarSlotsContext.Provider value={value}>{children}</TitleBarSlotsContext.Provider>
}

function SlotPortal({ slot, children }: { slot: Slot; children: ReactNode }) {
  const node = useContext(TitleBarSlotsContext)?.targets[slot]
  return node ? createPortal(children, node) : null
}

/**
 * Names the page after where it is, in the TitleBar under the same
 * TitleBarProvider: a slash, then its children as the heading.
 */
export function TitleBarTitle({ children }: { children: ReactNode }) {
  return (
    <SlotPortal slot='title'>
      <TitleBarSeparator />
      <h1 className='min-w-0 truncate px-1 text-sm font-medium'>{children}</h1>
    </SlotPortal>
  )
}

/** Sends its children into the actions area of the TitleBar under the same TitleBarProvider. */
export function TitleBarPortal({ children }: { children: ReactNode }) {
  return <SlotPortal slot='actions'>{children}</SlotPortal>
}

/** Sends its children into the toolbar row of the TitleBar under the same TitleBarProvider. */
export function TitleBarToolbar({ children }: { children: ReactNode }) {
  return <SlotPortal slot='toolbar'>{children}</SlotPortal>
}

export function TitleBarSeparator() {
  return (
    <span aria-hidden className='shrink-0 select-none text-lg font-light text-muted-foreground/40'>
      /
    </span>
  )
}

export function TitleBar({
  brand,
  brandCompact,
  context,
  title,
  onMenu,
  onBack,
  actions,
  trailing,
  toolbar,
  className,
  ...props
}: TitleBarProps) {
  const register = useContext(TitleBarSlotsContext)?.register
  const titleRef = useCallback((node: HTMLElement | null) => register?.('title', node), [register])
  const actionsRef = useCallback((node: HTMLElement | null) => register?.('actions', node), [register])

  // Everything in the toolbar row arrives by portal, the prop included, so
  // React never owns the row's children and the row can hide itself with
  // :empty the moment nothing is in it.
  const [toolbarNode, setToolbarNode] = useState<HTMLElement | null>(null)
  const toolbarRef = useCallback(
    (node: HTMLElement | null) => {
      setToolbarNode(node)
      register?.('toolbar', node)
    },
    [register],
  )

  return (
    <header
      data-slot='title-bar'
      className={cn('@container/title-bar w-full shrink-0 border-b bg-background pt-[env(safe-area-inset-top)]', className)}
      {...props}
    >
      <div className='flex h-12 items-center gap-1 px-2 pointer-fine:h-10'>
        {onMenu && (
          <TitleBarIconButton aria-label='Open sidebar' onClick={onMenu}>
            <PanelLeft />
          </TitleBarIconButton>
        )}
        {onBack && <BackButton onClick={onBack} className='pointer-coarse:size-10' />}

        {brand && <div className={cn(BRAND, brandCompact && 'hidden md:flex')}>{brand}</div>}
        {brandCompact && <div className={cn(BRAND, 'md:hidden')}>{brandCompact}</div>}
        {(brand || brandCompact) && context && <TitleBarSeparator />}
        <div className='flex min-w-0 flex-1 items-center gap-1'>
          {context}
          {title && <h1 className='min-w-0 truncate px-1 text-sm font-medium'>{title}</h1>}
          {register && <div ref={titleRef} className='contents' />}
        </div>

        {actions}
        {register && <div ref={actionsRef} className='contents' />}
        {trailing && <div className='flex shrink-0 items-center gap-1'>{trailing}</div>}
      </div>

      <div
        ref={toolbarRef}
        className='flex h-10 items-center gap-1 overflow-x-auto px-2 empty:hidden pointer-coarse:h-12'
      />
      {toolbar && toolbarNode && createPortal(toolbar, toolbarNode)}
    </header>
  )
}
