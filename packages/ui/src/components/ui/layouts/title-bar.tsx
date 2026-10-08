import { ArrowLeft, ArrowRight, Copy, Ellipsis, ExternalLink, PanelLeft } from 'lucide-react'
import {
  type ComponentProps,
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'

import { BackButton } from '../utils/back-button'
import { Button } from 'ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'
import { TitleDragHandle } from './title-drag-handle'
import { cn } from 'cn'

/**
 * Where a control that stands in for the browser's own shows. `installed`:
 * only while the app runs as an installed app in its own window, the
 * standalone and window-controls-overlay display modes, where the browser
 * draws neither its arrows nor its address bar. `always`: in a browser tab too.
 */
export type TitleBarShown = 'installed' | 'always'

export interface TitleBarProps extends Omit<ComponentProps<'header'>, 'title'> {
  /** The product mark, as a link home. Sits right after the sidebar button. */
  brand?: ReactNode
  /**
   * A smaller mark drawn instead of `brand` on a phone, since a truncated
   * wordmark is not a smaller one. "Phone" is the viewport under 768px, the
   * same line the app's useIsMobile draws, not the bar's own width.
   */
  brandCompact?: ReactNode
  /** Where the page is: one or more switchers, side by side. Follows the brand. */
  context?: ReactNode
  /** A heading for a surface that needs one, such as a nested screen. */
  title?: ReactNode
  /**
   * Shows Back and Forward through the app's history, first in the bar, before
   * the sidebar button. They stand in for the browser's own arrows, so by
   * default they show only where those are missing: see `historyButtons`.
   */
  onHistoryBack?: () => void
  onHistoryForward?: () => void
  /**
   * Whether there is anywhere to go back or forward to. False disables the
   * button, as the browser greys out its own arrow. Default true, for a host
   * that cannot tell.
   */
  canGoBack?: boolean
  canGoForward?: boolean
  /** When Back and Forward show. Default `installed`: see TitleBarShown. */
  historyButtons?: TitleBarShown
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

// An installed app in window-controls-overlay mode draws the bar into the
// window's own title bar, with the window buttons laid over one side of it
// (the right on Windows and Linux, the left on macOS). The buttons cover only
// the title bar area the browser reports, which is the bar's first row, so
// that row alone keeps clear of them and the toolbar row below keeps the
// window's full width. The first row folds by the width it has left, so it
// is a title-bar container of its own, nearer to its contents than the bar.
const WINDOW_CONTROLS =
  '[@media(display-mode:window-controls-overlay)]:ml-[env(titlebar-area-x,0px)] [@media(display-mode:window-controls-overlay)]:mr-[calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw))]'

// Decided by the display mode the page is actually running in, in CSS, so the
// buttons are right from the first paint, server-rendered included, with no
// script reading the mode after hydration and shifting the bar.
const HISTORY_SHOWN: Record<TitleBarShown, string> = {
  installed:
    'hidden [@media(display-mode:standalone)]:flex [@media(display-mode:window-controls-overlay)]:flex',
  always: 'flex',
}

// The display modes HISTORY_SHOWN lists, for a part drawn by script rather
// than hidden by a class: a menu draws its items only once it opens, after
// hydration, so in a browser tab the menu holds no such items at all rather
// than hidden ones.
const INSTALLED_DISPLAY_MODES = '(display-mode: standalone), (display-mode: window-controls-overlay)'

function subscribeToDisplayMode(onChange: () => void) {
  const query = window.matchMedia(INSTALLED_DISPLAY_MODES)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function useIsInstalledApp(): boolean {
  return useSyncExternalStore(
    subscribeToDisplayMode,
    () => window.matchMedia(INSTALLED_DISPLAY_MODES).matches,
    () => false,
  )
}

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

/**
 * Why Open link from clipboard opened nothing. `unreadable`: the clipboard
 * could not be read (refused, or not available here). `not-a-link`: it holds
 * no http or https address. `blocked`: the browser refused the new window.
 */
export type TitleBarOpenFailure = 'unreadable' | 'not-a-link' | 'blocked'

export interface TitleBarPageLinksProps {
  /** When the items show. Default `installed`: see TitleBarShown. */
  shown?: TitleBarShown
  /** Called once a copy settles: true when the page's address is on the clipboard. */
  onCopied?: (copied: boolean) => void
  /** Called when Open link from clipboard opens nothing, with the reason. */
  onOpenFailed?: (reason: TitleBarOpenFailure) => void
  /**
   * Goes to an address of this app, given as path, query and hash, the way
   * the host's router does. Default: loads it as a new page.
   */
  onNavigate?: (path: string) => void
}

// Runs a clipboard call right away, inside the press: WebKit allows the
// clipboard only while the user's gesture is still running. A missing
// clipboard (an insecure context) throws, and settles as a rejection instead.
function clipboardCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call()
  } catch (error) {
    return Promise.reject(error)
  }
}

// The clipboard's text as an address to open, or null. Only http and https:
// a javascript: or data: address would run whatever the clipboard holds.
function linkFrom(text: string): URL | null {
  try {
    const url = new URL(text.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function loadPage(path: string) {
  window.location.assign(path)
}

/**
 * Copy link to this page and Open link from clipboard, then a separator, for
 * the top of a menu the bar opens, such as the account menu. They stand in
 * for the address bar, so by default they show only where it is missing.
 * Copy reads the page's address as it is pressed. Open goes to the address on
 * the clipboard as if it were typed into an address bar: an address of this
 * app opens in this window, any other site's in a new window, which the
 * platform places (usually the browser).
 */
export function TitleBarPageLinks({
  shown = 'installed',
  onCopied,
  onOpenFailed,
  onNavigate = loadPage,
}: TitleBarPageLinksProps) {
  const isInstalledApp = useIsInstalledApp()
  if (shown === 'installed' && !isInstalledApp) {
    return null
  }

  const copy = () => {
    clipboardCall(() => navigator.clipboard.writeText(window.location.href)).then(
      () => onCopied?.(true),
      () => onCopied?.(false),
    )
  }

  const openFromClipboard = () => {
    clipboardCall(() => navigator.clipboard.readText()).then(
      (text) => {
        const link = linkFrom(text)
        if (!link) {
          onOpenFailed?.('not-a-link')
          return
        }
        if (link.origin === window.location.origin) {
          onNavigate(link.pathname + link.search + link.hash)
          return
        }
        // Opened without the noopener feature, which makes window.open answer
        // null even when the window opened, so a blocked window can be told
        // apart. The opener is cut by hand before the new page loads.
        const opened = window.open(link.href, '_blank')
        if (!opened) {
          onOpenFailed?.('blocked')
          return
        }
        opened.opener = null
      },
      () => onOpenFailed?.('unreadable'),
    )
  }

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={copy}>
          <Copy />
          Copy link to this page
        </DropdownMenuItem>
        <DropdownMenuItem onClick={openFromClipboard}>
          <ExternalLink />
          Open link from clipboard
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
    </>
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
 * TitleBarProvider: its children as the heading.
 */
export function TitleBarTitle({ children }: { children: ReactNode }) {
  return (
    <SlotPortal slot='title'>
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

export function TitleBar({
  brand,
  brandCompact,
  context,
  title,
  onHistoryBack,
  onHistoryForward,
  canGoBack = true,
  canGoForward = true,
  historyButtons = 'installed',
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
      className={cn(
        '@container/title-bar w-full shrink-0 border-b bg-background pt-[env(safe-area-inset-top)]',
        className,
      )}
      {...props}
    >
      <div className={cn('@container/title-bar', WINDOW_CONTROLS)}>
        <div className='flex h-12 items-center gap-1 px-2 pointer-fine:h-10'>
          {(onHistoryBack || onHistoryForward) && (
            <div className={cn('shrink-0 items-center gap-1', HISTORY_SHOWN[historyButtons])}>
              {onHistoryBack && (
                <TitleBarIconButton aria-label='Go back' title='Go back' disabled={!canGoBack} onClick={onHistoryBack}>
                  <ArrowLeft />
                </TitleBarIconButton>
              )}
              {onHistoryForward && (
                <TitleBarIconButton
                  aria-label='Go forward'
                  title='Go forward'
                  disabled={!canGoForward}
                  onClick={onHistoryForward}
                >
                  <ArrowRight />
                </TitleBarIconButton>
              )}
            </div>
          )}
          {onMenu && (
            <TitleBarIconButton aria-label='Open sidebar' onClick={onMenu}>
              <PanelLeft />
            </TitleBarIconButton>
          )}
          {onBack && <BackButton onClick={onBack} className='pointer-coarse:size-10' />}

          {brand && <div className={cn(BRAND, brandCompact && 'hidden md:flex')}>{brand}</div>}
          {brandCompact && <div className={cn(BRAND, 'md:hidden')}>{brandCompact}</div>}
          {/* The row's free width is the bar's one drag handle: the context and the
              title take only what they need, and the handle takes the rest. */}
          <div className='flex min-w-0 flex-1 items-center gap-1 self-stretch'>
            {context}
            {title && <h1 className='min-w-0 truncate px-1 text-sm font-medium'>{title}</h1>}
            {register && <div ref={titleRef} className='contents' />}
            <TitleDragHandle />
          </div>

          {actions}
          {register && <div ref={actionsRef} className='contents' />}
          {trailing && <div className='flex shrink-0 items-center gap-1'>{trailing}</div>}
        </div>
      </div>

      <div
        ref={toolbarRef}
        className='flex h-10 items-center gap-1 overflow-x-auto px-2 empty:hidden pointer-coarse:h-12'
      />
      {toolbar && toolbarNode && createPortal(toolbar, toolbarNode)}
    </header>
  )
}
