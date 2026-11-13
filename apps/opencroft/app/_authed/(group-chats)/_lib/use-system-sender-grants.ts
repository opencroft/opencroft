'use client'

import { useEffect, useState } from 'react'

import { listGroupChatMembers, listSystemSenders } from '@/app/_authed/(group-chats)/_server/actions'

/** A chat's automated-sender grants as last read, and the senders it does not grant yet. */
export interface SystemSenderGrants {
  /** 'loading' only until the first read answers; later reads keep the last answer on screen. */
  state: 'loading' | 'loaded' | 'failed'
  granted: string[]
  grantable: string[]
}

const LOADING: SystemSenderGrants = { state: 'loading', granted: [], grantable: [] }

/**
 * The automated senders `groupChatId` grants, read while `enabled` and read
 * again whenever `revision` changes. A read overtaken by a later one is
 * dropped, so an older answer never lands after a newer.
 */
export function useSystemSenderGrants(groupChatId: string, enabled: boolean, revision: unknown): SystemSenderGrants {
  const [grants, setGrants] = useState<SystemSenderGrants>(LOADING)
  // biome-ignore lint/correctness/useExhaustiveDependencies(revision): not read in the body -- a change of it is what asks for the next read
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void Promise.all([listGroupChatMembers({ data: groupChatId }), listSystemSenders()])
      .then(([rows, senders]) => {
        if (cancelled) {
          return
        }
        const granted = rows.flatMap((r) => (r.principalType === 'system' && r.systemId ? [r.systemId] : []))
        setGrants({ state: 'loaded', granted, grantable: senders.filter((id) => !granted.includes(id)) })
      })
      .catch(() => {
        if (!cancelled) {
          setGrants({ state: 'failed', granted: [], grantable: [] })
        }
      })
    return () => {
      cancelled = true
    }
  }, [groupChatId, enabled, revision])
  return grants
}
