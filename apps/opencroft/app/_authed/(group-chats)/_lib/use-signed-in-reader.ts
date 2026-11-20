import { useRouteContext } from '@tanstack/react-router'
import { useMemo } from 'react'

import type { ResolvedAuthor } from '@/app/_authed/(agent)/_lib/acp-stream'

/**
 * Who is signed in, as a message they send is drawn under until the server's
 * own resolution of its author arrives with it: the account's name (its email
 * when it has none, as the account menu shows it) and avatar, from the route
 * context the signed-in shell already carries. One identity across renders
 * while the account is unchanged, so it can feed a memoized message list.
 */
export function useSignedInReader(): ResolvedAuthor {
  const { account } = useRouteContext({ from: '/_authed' })
  const name = account.name || account.email
  const avatarUrl = account.avatarUrl
  return useMemo(() => ({ name, avatarUrl }), [name, avatarUrl])
}
