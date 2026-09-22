'use client'

import { useEffect, useState } from 'react'

import { describeGraphRefs } from '@/app/_authed/(extension-runtime)/_server/actions'
import type { GraphRefInfo } from '@/app/_authed/(extension-runtime)/_server/graph-refs'

// Every ref asked for in the same tick goes out as ONE request: a list of
// NodeRef/TerminalRef rows mounts together, and one round trip per row is the
// cost this batching exists to avoid.
const pending = new Map<string, Array<(info: GraphRefInfo | null) => void>>()
let scheduled = false

// Answers are reused briefly, so a list that re-mounts (a tab switch, a
// re-opened inspector) does not ask again -- and only briefly, so a rename
// shows up the next time the ref mounts rather than never.
const FRESH_MS = 5000
const answered = new Map<string, { at: number; info: GraphRefInfo | null }>()

function flush(): void {
  scheduled = false
  const batch = new Map(pending)
  pending.clear()
  const settle = (answers: Record<string, GraphRefInfo | null>) => {
    const at = Date.now()
    for (const [id, waiters] of batch) {
      const info = answers[id] ?? null
      answered.set(id, { at, info })
      for (const resolve of waiters) {
        resolve(info)
      }
    }
  }
  describeGraphRefs({ data: { ids: [...batch.keys()] } })
    .then(settle)
    .catch(() => settle({}))
}

function describe(id: string): Promise<GraphRefInfo | null> {
  const known = answered.get(id)
  if (known && Date.now() - known.at < FRESH_MS) {
    return Promise.resolve(known.info)
  }
  return new Promise((resolve) => {
    const waiters = pending.get(id)
    if (waiters) {
      waiters.push(resolve)
    } else {
      pending.set(id, [resolve])
    }
    if (!scheduled) {
      scheduled = true
      setTimeout(flush, 0)
    }
  })
}

export type GraphRefState = { status: 'loading' } | { status: 'known'; info: GraphRefInfo } | { status: 'unknown' }

/** What a node / App instance id stands for, resolved across every space. */
export function useGraphRef(id: string): GraphRefState {
  const [state, setState] = useState<GraphRefState>({ status: 'loading' })
  useEffect(() => {
    if (!id) {
      setState({ status: 'unknown' })
      return
    }
    let current = true
    setState({ status: 'loading' })
    describe(id).then((info) => {
      if (current) {
        setState(info ? { status: 'known', info } : { status: 'unknown' })
      }
    })
    return () => {
      current = false
    }
  }, [id])
  return state
}
