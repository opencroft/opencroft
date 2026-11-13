import { type RegisteredRouter, useParams, useRouter, useRouterState, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'

import { levelsUnderThread, REACHED_IN_CHAT, type ThreadLevel } from '@/app/_authed/(group-chats)/_lib/thread-levels'

// The width from which the chats page shows both panels: MenuLayout's `md`.
const BOTH_PANELS_QUERY = '(min-width: 48rem)'

interface ThreadTarget {
  groupChatId: string
  threadId: string
  at?: number
}

function chatPath(router: RegisteredRouter, groupChatId: string): string {
  return router.buildLocation({ to: '/group-chats/$groupChatId', params: { groupChatId } }).pathname
}

function levelsFor(router: RegisteredRouter, target: ThreadTarget, below: string | undefined): ThreadLevel[] {
  return levelsUnderThread({
    below,
    chatPath: chatPath(router, target.groupChatId),
    bothPanels: window.matchMedia(BOTH_PANELS_QUERY).matches,
  })
}

/**
 * Writes `levels` and then the thread as history entries, the first over the
 * current entry when `replaceCurrent` is set. Each is a router navigation, so
 * every entry carries the router's own state and index and Back pops through
 * them like any other.
 *
 * @tanstack/history's browser history queues a push and writes it to the
 * browser a microtask later, and a push queued before that write takes its
 * place, so without a flush only the last entry would exist. The router queues
 * the push synchronously while no navigation blocker is registered, so a flush
 * after each navigation writes it before the next is queued. Tripwire: on a
 * phone, a thread's address opened fresh, then system Back, lands on the
 * thread's chat; leaving the app means the entries were not written.
 */
function writeThreadEntries(
  router: RegisteredRouter,
  target: ThreadTarget,
  levels: ThreadLevel[],
  replaceCurrent: boolean,
) {
  let replace = replaceCurrent
  const write = (navigation: Promise<void>) => {
    void navigation
    replace = false
    router.history.flush()
  }
  for (const level of levels) {
    write(
      level === 'chats'
        ? router.navigate({ to: '/group-chats', replace })
        : router.navigate({ to: '/group-chats/$groupChatId', params: { groupChatId: target.groupChatId }, replace }),
    )
  }
  write(
    router.navigate({
      to: '/group-chats/$groupChatId/$threadId',
      params: { groupChatId: target.groupChatId, threadId: target.threadId },
      search: target.at === undefined ? {} : { at: target.at },
      state: REACHED_IN_CHAT,
      replace,
    }),
  )
}

/**
 * Opens a thread from wherever the reader is on the chats page (Recent), with
 * the levels it is reached by pushed under it first.
 */
export function useOpenThreadWithLevels(): (target: ThreadTarget) => void {
  const router = useRouter()
  return useCallback(
    (target: ThreadTarget) => {
      writeThreadEntries(router, target, levelsFor(router, target, router.state.location.pathname), false)
    },
    [router],
  )
}

/**
 * Gives a thread that arrived without the levels it is reached by -- its
 * address loaded fresh, or a link from elsewhere in the app -- those levels
 * under it, by writing them over its entry and the thread again on top. Called
 * from the chats page's layout route, which stays mounted while chats and
 * threads change beside it, so it knows the entry each arrival sits on.
 *
 * An entry Back or Forward returns to is left as it is: it is already one of
 * the entries written here or by an in-app opening, and rewriting history
 * there would drop the entries ahead of it. Only a traversal made while this
 * page is mounted is seen as one. Back from another page onto a thread entry
 * without the mark reads as an arrival and gets the levels; every thread entry
 * this page renders is marked by then, so that is only an entry an older build
 * left in the browser's history.
 */
export function useThreadLevelsOnArrival() {
  const router = useRouter()
  // The resolved location, not the latest one: the params below come from the
  // rendered matches, which change with it. The latest location moves as soon
  // as a navigation starts, so leaving a thread for another page would read as
  // that page's entry with the thread's params.
  const location = useRouterState({ select: (state) => state.resolvedLocation })
  const { groupChatId, threadId } = useParams({ strict: false })
  const { at } = useSearch({ strict: false })
  const handledKey = useRef<string | undefined>(undefined)
  const below = useRef<string | undefined>(undefined)
  const arrivedByPop = useRef(false)

  useEffect(
    () =>
      router.history.subscribe(({ action }) => {
        arrivedByPop.current = action.type !== 'PUSH' && action.type !== 'REPLACE'
      }),
    [router],
  )

  useEffect(() => {
    if (!location) {
      return
    }
    // Once per entry: StrictMode runs a mount effect twice, and rewriting
    // history twice would stack the levels twice.
    if (handledKey.current === location.state.__TSR_key) {
      return
    }
    handledKey.current = location.state.__TSR_key
    const previous = below.current
    below.current = location.pathname
    if (!groupChatId || !threadId || location.state.threadReachedInChat || arrivedByPop.current) {
      return
    }
    const target = { groupChatId, threadId, at }
    writeThreadEntries(router, target, levelsFor(router, target, previous), true)
  }, [router, location, groupChatId, threadId, at])
}
