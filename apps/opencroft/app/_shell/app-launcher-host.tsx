'use client'

import { useRouteContext, useRouter } from '@tanstack/react-router'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppLauncher,
  type AppLauncherApp,
  type AppLauncherPage,
  type AppLauncherSearchProps,
} from 'ui/layouts/app-launcher'

import { listAllSpaceApps, listApps } from '@/app/_authed/(apps)/_server/actions'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'
import { useAccountPages } from '@/app/_shell/account-menu'
import { useRecentApps, useRecordRecentApp } from '@/app/_shell/recent-apps'
import { CHATS_PATH, ROOTS } from '@/app/_shell/roots'
import { type SpaceNavigation, toSpaceApp } from '@/app/_shell/space-navigation'
import { useHistoryBackClose } from '@/hooks/utils/use-history-back-close'

// The chats; the other roots are the launcher itself, the spaces it lists and
// the account, whose pages follow these.
const ROOT_PAGES: AppLauncherPage[] = ROOTS.filter((root) => root.path === CHATS_PATH).map(({ path, label, icon }) => ({
  label,
  href: path,
  icon,
}))

const hrefFor = (slug: string) => `/space/${slug}`

const settingsHrefFor = (slug: string) => `/space/${slug}/settings`

const appSettingsHref = (spaceSlug: string, appSlug: string) => `/space/${spaceSlug}/settings/app/${appSlug}`

/**
 * How long after a swipe the next one still walks further back through the
 * history it started from, rather than starting over from the new order.
 */
const SWIPE_SESSION_MS = 2000

type SearchData = Omit<AppLauncherSearchProps, 'onNavigate' | 'onChoose' | 'className'>

interface AppLauncherControl {
  /** Opens the App Launcher dialog over the page, as Cmd+K does. */
  open: () => void
  /** What the App Launcher lists, for the page that shows it. */
  search: SearchData
  /** Fetches every space's apps again, so one added since shows up. */
  refresh: () => void
  /**
   * Steps through the recent apps without opening the launcher: `back` goes to the
   * app before this one, and again within a moment to the one before that;
   * `forward` retraces those steps.
   */
  step: (direction: 'back' | 'forward') => void
}

const AppLauncherContext = createContext<AppLauncherControl | null>(null)

/** The App Launcher's shortcut keys as this platform writes them; the Mac's until the page has loaded. */
function useShortcutLabel() {
  const [keys, setKeys] = useState(['⌘', 'K'])
  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
      setKeys(['Ctrl', 'K'])
    }
  }, [])
  return keys
}

/** The App Launcher's data and controls, for the chrome's own entry points and the App Launcher page. */
export function useAppLauncher(): AppLauncherControl {
  const control = useContext(AppLauncherContext)
  if (!control) {
    throw new Error('useAppLauncher must be used inside AppLauncherHost')
  }
  return control
}

/**
 * The App Launcher's data, the recent-app history, and the Cmd+K (Ctrl+K off a
 * Mac) dialog. On a phone the App Launcher is a page (`APPS_PATH`), which reads
 * the same data through `useAppLauncher`.
 */
export function AppLauncherHost({
  spaces,
  navigation,
  children,
}: {
  spaces: SpaceSummary[]
  navigation: SpaceNavigation
  children: ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [apps, setApps] = useState<AppLauncherApp[]>([])
  // Whether the first fetch has settled, so the launcher can tell "none" from
  // "not yet".
  const [settled, setSettled] = useState(false)
  useRecordRecentApp(navigation.activeAppId)
  const recentIds = useRecentApps()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The physical key, so the shortcut works in every keyboard layout.
      if (event.code === 'KeyK' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        setOpen((was) => !was)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Fetched at mount, for swiping before the launcher has ever been shown, at
  // every opening of the dialog and whenever the page asks. One fetch at a
  // time: an ask while one is under way is answered by it, so the page's ask
  // on a fresh load of /apps does not fetch twice.
  const fetching = useRef(false)
  const refresh = useCallback(() => {
    if (fetching.current) {
      return
    }
    fetching.current = true
    Promise.all([listAllSpaceApps(), listApps()])
      .then(([entries, metas]) => {
        setApps(
          entries.map((entry) => ({
            ...toSpaceApp(entry.spaceSlug, entry, metas),
            spaceSlug: entry.spaceSlug,
            settingsHref: appSettingsHref(entry.spaceSlug, entry.slug),
          })),
        )
      })
      .catch(() => {
        // The spaces stay listed; only the apps are missing until the next fetch.
      })
      .finally(() => {
        fetching.current = false
        setSettled(true)
      })
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])
  useEffect(() => {
    if (open) {
      refresh()
    }
  }, [open, refresh])

  // The settings buttons are an administrator's, decided by the same `isAdmin`
  // the account menu shows the Administration page by.
  const { isAdmin } = useRouteContext({ from: '/_authed' })
  const listed = useMemo(() => (isAdmin ? apps : apps.map(({ settingsHref: _, ...app }) => app)), [apps, isAdmin])

  // The history without the open app and without apps that no longer exist.
  const recent = useMemo(() => {
    const byId = new Map(listed.map((app) => [app.id, app]))
    return recentIds
      .filter((id) => id !== navigation.activeAppId)
      .flatMap((id) => {
        const app = byId.get(id)
        return app ? [app] : []
      })
  }, [listed, recentIds, navigation.activeAppId])

  // A run of swipes walks the history as it was when the run started; the
  // visits it makes reorder the history only for the next run.
  const swipeRun = useRef<{ trail: AppLauncherApp[]; at: number; timer?: ReturnType<typeof setTimeout> } | null>(null)
  const appsRef = useRef({ apps, recent, activeAppId: navigation.activeAppId })
  appsRef.current = { apps, recent, activeAppId: navigation.activeAppId }

  const step = useCallback(
    (direction: 'back' | 'forward') => {
      let run = swipeRun.current
      if (!run) {
        if (direction === 'forward') {
          return
        }
        const { apps: all, recent: history, activeAppId } = appsRef.current
        const here = all.find((app) => app.id === activeAppId)
        run = { trail: here ? [here, ...history] : history, at: here ? 0 : -1 }
        swipeRun.current = run
      }
      const next = run.at + (direction === 'back' ? 1 : -1)
      const target = run.trail[next]
      clearTimeout(run.timer)
      run.timer = setTimeout(() => {
        swipeRun.current = null
      }, SWIPE_SESSION_MS)
      if (!target) {
        return
      }
      run.at = next
      router.history.push(target.href)
    },
    [router],
  )

  // Back closes the dialog. Choosing in it leaves the dialog's history entry
  // before navigating, so the new page takes that entry's place.
  const leaveThen = useHistoryBackClose(open, () => setOpen(false))

  // Kept stable between renders, so the page showing the launcher re-renders
  // only when what it lists changes, not with every render of the shell.
  const currentSlug = navigation.slug ?? recent[0]?.spaceSlug
  const accountPages = useAccountPages()
  const pages = useMemo<AppLauncherPage[]>(
    () => [...ROOT_PAGES, ...accountPages.map(({ label, to, icon }) => ({ label, href: to, icon }))],
    [accountPages],
  )
  const search = useMemo<SearchData>(
    () => ({
      spaces,
      // Off a space's pages, such as the App Launcher page itself, the space of
      // the app the reader came from.
      currentSlug,
      apps: listed,
      recent,
      activeAppId: navigation.activeAppId,
      pages,
      hrefFor,
      settingsHrefFor: isAdmin ? settingsHrefFor : undefined,
      loading: !settled,
    }),
    [spaces, currentSlug, listed, recent, navigation.activeAppId, pages, settled, isAdmin],
  )
  const show = useCallback(() => setOpen(true), [])
  const control = useMemo(() => ({ open: show, search, refresh, step }), [show, search, refresh, step])
  const shortcut = useShortcutLabel()

  return (
    <AppLauncherContext.Provider value={control}>
      {children}
      <AppLauncher
        {...search}
        shortcut={shortcut}
        open={open}
        onOpenChange={setOpen}
        onNavigate={(href) => leaveThen(() => router.history.push(href))}
      />
    </AppLauncherContext.Provider>
  )
}
