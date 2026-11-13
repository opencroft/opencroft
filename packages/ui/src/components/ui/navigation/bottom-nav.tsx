import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cn } from 'cn'
import type { ComponentProps, ReactNode } from 'react'

interface BottomNavProps extends ComponentProps<'nav'> {
  /**
   * Stretch the pill across the bar, its items sharing the width equally. By default the pill is
   * only as wide as its items, centred in the bar.
   */
  fill?: boolean
}

/**
 * A floating pill of top-level destinations at the bottom of a narrow screen.
 *
 * It renders as a bar the width of its container holding the pill. The bar insets the pill from the
 * left, right and bottom edges by 1rem plus the safe-area insets, which are non-zero only when the
 * viewport meta opts into `viewport-fit=cover`, and lets presses through to whatever is under it
 * beside the pill. A FloatingActions stack keeps the same 1rem from the right edge and floats in
 * that corner just above the bar, whatever the pill's width. The props, `className` included, go to
 * the pill, the `<nav>`.
 *
 * Mount it in a bottom StickySection with `withSpacing={false}` at the end of the content that
 * scrolls: the content scrolls under the pill, and at its end the section takes the bar's height,
 * so the last row scrolls clear of it. Or float the bar over a page that scrolls in several places,
 * and give each of them room at its end the bar's height.
 *
 * The items are equal columns, each as wide as the widest one's icon and label: by default the pill
 * is as wide as they need and centred, and with `fill` it spans the bar and they share it. Either
 * way the pill never wraps or scrolls; when the bar is too narrow, the columns narrow together and
 * each label truncates inside its item. The items fill the pill's height inside its padding and are
 * fully rounded, so the pill's radius is an item's radius plus that padding and the current item's
 * highlight is concentric with the pill's ends, with the padding an even frame all round. A border
 * on the pill would add its width to that sum; the outline is a ring for that reason.
 */
function BottomNav({ fill = false, className, ...props }: BottomNavProps) {
  return (
    <div
      data-slot='bottom-nav-bar'
      className='pointer-events-none flex w-full min-w-0 justify-center pr-[calc(env(safe-area-inset-right,0px)+1rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pl-[calc(env(safe-area-inset-left,0px)+1rem)]'
    >
      <nav
        data-slot='bottom-nav'
        data-fill={fill || undefined}
        className={cn(
          'pointer-events-auto grid min-w-0 auto-cols-[minmax(0,1fr)] grid-flow-col rounded-full bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10',
          fill ? 'w-full' : 'w-fit',
          className,
        )}
        {...props}
      />
    </div>
  )
}

interface BottomNavItemProps extends Omit<useRender.ComponentProps<'a'>, 'children'> {
  /** The destination's icon, drawn large above the label. An `svg` is sized by the item. */
  icon: ReactNode
  /** The destination's name, shown small under the icon and truncated to the item's width. */
  label: string
  /**
   * The destination the user is on: the whole item, icon and label, is tinted, and it carries
   * `aria-current="page"` and `data-active`.
   */
  active?: boolean
}

/**
 * One destination of a `BottomNav`. Renders an `<a>`; pass `render` to render the host router's
 * link instead (`render={<Link to='/inbox' />}`), and the item's classes and props are merged onto
 * it. The item is its own highlight: a fully rounded box the pill's height inside its padding, which
 * takes the press.
 *
 * Its side padding keeps the label and the icon inside its rounded ends. An item is 50px tall (0.25rem
 * padding, 24px icon, 2px gap, 16px label line, 0.25rem padding), so each end is a half-circle of
 * 25px radius. The label's line box reaches 21px from the item's centre line, and so does the icon's
 * top; at 21px from its centre a 25px circle is 25 - sqrt(25^2 - 21^2), about 11.4px, in from the
 * end, so the padding is the next step up, 0.75rem (`px-3`). A taller item would need less, a
 * shorter one more.
 */
function BottomNavItem({ icon, label, active = false, className, render, ...props }: BottomNavItemProps) {
  return useRender({
    defaultTagName: 'a',
    render,
    props: mergeProps<'a'>(
      {
        className: cn(
          'flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-full px-3 py-1 text-muted-foreground outline-none transition-colors select-none [-webkit-tap-highlight-color:transparent] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-active:bg-primary/15 data-active:text-primary',
          className,
        ),
        'aria-current': active ? 'page' : undefined,
        children: (
          <>
            <span
              data-slot='bottom-nav-item-icon'
              className='flex size-6 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:size-6 [&_svg]:shrink-0'
            >
              {icon}
            </span>
            <span data-slot='bottom-nav-item-label' className='max-w-full truncate text-center text-xs leading-4 font-medium'>
              {label}
            </span>
          </>
        ),
      },
      props,
    ),
    state: { slot: 'bottom-nav-item', active },
  })
}

export { BottomNav, BottomNavItem }
