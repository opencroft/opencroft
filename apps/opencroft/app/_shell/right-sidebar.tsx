'use client'

import { type ComponentType, useState } from 'react'
import { Flex } from 'ui/components/ui/layout/flex'
import { Separator } from 'ui/components/ui/separator'
import { Sidebar, SidebarContent, SidebarStateProvider } from 'ui/components/ui/sidebar'

import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/_authed/(extension-runtime)/_client/provides'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'

/**
 * Provider point a panel is published under to appear in the right sidebar.
 *
 * Nothing has to be registered with the host to use it — a panel is declared
 * the same way an extension declares anything else it offers:
 *
 *     provides: { 'right-sidebar-panels': [{ id, label, icon, component }] }
 */
export const RIGHT_SIDEBAR_PANELS = 'right-sidebar-panels'

export interface RightSidebarPanel {
  id: string
  label: string
  /** Lucide icon name; falls back to a placeholder when absent or unknown. */
  icon?: string
  component: ComponentType
}

// Its own key, and no keyboard shortcut. The sidebar that owns the row keeps
// the shared chord, and two sidebars writing one key would each overwrite what
// the other remembers.
const STORAGE_KEY = 'right_sidebar_state'

/**
 * A panel host on the right of the application shell.
 *
 * It renders nothing at all until something publishes a panel into it, so a
 * page with no contributions is exactly as it was.
 *
 * It joins the row that the left sidebar and the page content already share,
 * which is why it takes the sidebar state without the wrapper: a second
 * full-width flex container inside that row would change the layout rather
 * than join it. For the same reason it inherits the row's sidebar width rather
 * than setting its own — the width is a property of the row, and the element
 * that reserves space for a sidebar reads it from there.
 */
export function RightSidebar() {
  const { items } = useProvided<RightSidebarPanel>(RIGHT_SIDEBAR_PANELS, loadAllExtensions)
  const [activeId, setActiveId] = useState<string | null>(null)

  if (items.length === 0) {
    return null
  }

  // Falling back to the first panel rather than holding an id that no longer
  // resolves: an extension can be reloaded, and the panel that was open may not
  // come back.
  const active = items.find((panel) => panel.id === activeId) ?? items[0]
  const Body = active.component

  return (
    <SidebarStateProvider storageKey={STORAGE_KEY} keyboardShortcut={null}>
      <Sidebar side='right' data-testid='right-sidebar'>
        <Flex row className='items-center gap-0 px-3 pt-2 pb-0'>
          {items.map((panel) => {
            const PanelIcon = resolveIcon(panel.icon)
            const isActive = panel.id === active.id
            return (
              <button
                key={panel.id}
                type='button'
                onClick={() => setActiveId(panel.id)}
                className={[
                  'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border-b-2 transition-colors',
                  isActive
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground/80',
                ].join(' ')}
              >
                <PanelIcon className='size-3' />
                {panel.label}
              </button>
            )
          })}
        </Flex>
        <Separator />
        <SidebarContent>
          <Body />
        </SidebarContent>
      </Sidebar>
    </SidebarStateProvider>
  )
}
