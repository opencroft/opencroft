'use client'

import { Link, useRouter } from '@tanstack/react-router'
import { LayoutGrid } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'ui/dropdown-menu'
import { useIsMobile } from 'ui/hooks/use-mobile'

import { useAppLauncher } from '@/app/_shell/app-launcher-host'
import { appsOfType } from '@/app/_shell/apps-of-type'
import { APPS_PATH } from '@/app/_shell/roots'
import type { SpaceApp } from '@/app/_shell/space-navigation'

interface Props {
  /** The space's apps; the menu lists those of the open app's type. */
  apps: SpaceApp[]
  activeApp: SpaceApp
  spaceSlug: string
  /** Classes for the trigger. */
  className?: string
  /** The trigger's content: where the reader is. */
  children: ReactNode
}

/**
 * The open app's name as a menu of the apps of its type in its space, by name
 * as the App Launcher lists them, the open one checked; an app alone of its
 * type is listed alone. Picking another goes to it as the launcher does, one
 * history entry on top of this one. All apps opens the launcher: its dialog
 * from md up, its page on a phone.
 */
export function AppTypeMenu({ apps, activeApp, spaceSlug, className, children }: Props) {
  const router = useRouter()
  const launcher = useAppLauncher()
  const isMobile = useIsMobile()
  const listed = useMemo(() => appsOfType(apps, activeApp, spaceSlug), [apps, activeApp, spaceSlug])

  function choose(id: unknown) {
    const app = listed.find((each) => each.id === id)
    if (app && app.id !== activeApp.id) {
      router.history.push(app.href)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type='button' className={className} />}>{children}</DropdownMenuTrigger>
      {/* At least the bar's room for a name, at most the screen's width. */}
      <DropdownMenuContent className='w-auto min-w-56 max-w-(--available-width)'>
        <DropdownMenuRadioGroup value={activeApp.id} onValueChange={choose}>
          {/* `closeOnClick`: a radio item keeps the menu open on a press by
              default, and choosing one here leaves for that app. */}
          {listed.map(({ id, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={id} value={id} closeOnClick>
              {Icon && <Icon />}
              <span className='min-w-0 truncate'>{label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {isMobile ? (
            <DropdownMenuItem render={<Link to={APPS_PATH} />}>
              <LayoutGrid />
              All apps
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={launcher.open}>
              <LayoutGrid />
              All apps
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
