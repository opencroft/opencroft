'use client'

import { type ComponentType, useState } from 'react'
import { Sidebar, SidebarContent, SidebarStateProvider } from 'ui/components/ui/sidebar'
import { PanelTabStrip } from 'ui/layouts/panel-tab-strip'

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
        <PanelTabStrip
          tabs={items.map((panel) => ({ id: panel.id, label: panel.label, icon: resolveIcon(panel.icon) }))}
          activeId={active.id}
          onSelect={setActiveId}
        />
        <SidebarContent>
          <Body />
        </SidebarContent>
      </Sidebar>
    </SidebarStateProvider>
  )
}
