import { type Layout, type LayoutStorage, useDefaultLayout } from 'react-resizable-panels'

// localStorage in the browser, nothing on the server: a resizable group renders
// on the server too, and there is no stored layout to read there.
const layoutStorage: LayoutStorage = {
  getItem: (key) => (typeof window === 'undefined' ? null : window.localStorage.getItem(key)),
  setItem: (key, value) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(key, value)
    }
  },
}

/**
 * A resizable group's layout, remembered per browser under `id`. `panelIds`
 * lists the panels rendered right now, so a group whose panels come and go
 * (a sidebar, an inspector) keeps one layout per arrangement.
 */
export function useRememberedLayout(
  id: string,
  panelIds: string[],
): { defaultLayout: Layout | undefined; onLayoutChanged: (layout: Layout) => void } {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id, panelIds, storage: layoutStorage })
  return { defaultLayout, onLayoutChanged }
}
