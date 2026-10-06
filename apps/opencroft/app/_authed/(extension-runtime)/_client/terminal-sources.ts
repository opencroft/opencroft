'use client'

import { useEffect, useState } from 'react'
import type { TerminalListSource } from 'ui/nodes/terminal-list'

import {
  describeGraphRef,
  describeGraphRefs,
  type GraphRefDescription,
  splitTarget,
  subscribeGraphRefs,
} from '@/app/_authed/(extension-runtime)/_client/graph-refs'
import { refIcon } from '@/app/_authed/(extension-runtime)/_client/node-ref'
import { listTerminalSources, listTerminalSourceTargets } from '@/app/_authed/(extension-runtime)/_server/actions'
import type {
  TerminalSourceInfo,
  TerminalSourceTarget,
} from '@/app/_authed/(extension-runtime)/_server/terminal-sources'

interface ListedTerminal {
  target: string
  /** Which of its owner's terminals this is; '' when the owner has only the one. */
  name: string
  unavailable?: boolean
}

// One source as Terminal List draws it: the owner by the name its user gave
// it, and each terminal by what tells it apart from the owner's others. A
// terminal without one is its owner's only terminal and goes unnamed, so a row
// that stands alone -- a router's one route to a node with several -- still
// says which terminal it is whenever there is something to tell apart. Its
// kind is told by the icon in the colour the canvas gives the node type; an
// App has none, so it stays in the text colour.
export function listSource(
  id: string,
  owner: GraphRefDescription | null,
  terminals: ListedTerminal[],
  { loading, showSpace }: { loading?: boolean; showSpace?: boolean },
): TerminalListSource {
  return {
    id,
    name: owner?.name ?? 'Unknown node',
    icon: owner ? refIcon(owner) : undefined,
    accent: owner?.accent,
    space: showSpace ? owner?.spaceSlug : undefined,
    terminals: terminals.map((terminal) => ({ ...terminal, name: terminal.name || undefined })),
    loading,
  }
}

interface SourcesState {
  /** Null until the first answer: the sources themselves are not known yet. */
  infos: TerminalSourceInfo[] | null
  expanded: Record<string, TerminalSourceTarget[]>
  /** Sources being expanded right now. */
  pending: string[]
}

const EMPTY: SourcesState = { infos: null, expanded: {}, pending: [] }

// The last answer per space, shared by every selector: a selector that mounts
// again shows it at once and refreshes underneath, each source keeping its old
// terminals until its new ones arrive.
const lastAnswer = new Map<string, SourcesState>()

// Calls still on their way, keyed by what they ask: a selector and a list
// mounted together -- a router's inspector -- ask once between them.
const inFlight = new Map<string, Promise<unknown>>()

function shared<T>(key: string, ask: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key) as Promise<T> | undefined
  if (pending) {
    return pending
  }
  const asked = ask().finally(() => inFlight.delete(key))
  inFlight.set(key, asked)
  return asked
}

/**
 * Every terminal source for a picker, as Terminal List sources. The sources
 * arrive in one fast call; those whose terminals have to be asked for (a docker
 * host, an App) are then asked all at once, each filling in as it answers, so
 * a slow or unreachable one only keeps its own group loading.
 */
export function useTerminalSources(spaceSlug?: string): { sources: TerminalListSource[]; loading: boolean } {
  const key = spaceSlug ?? ''
  const [state, setState] = useState<SourcesState>(() => lastAnswer.get(key) ?? EMPTY)

  useEffect(() => {
    let mounted = true
    let snapshot = lastAnswer.get(key) ?? EMPTY
    // Answers that land after unmount still reach the shared copy, so the next
    // mount starts from them.
    const publish = (next: SourcesState) => {
      snapshot = next
      lastAnswer.set(key, next)
      if (mounted) {
        setState(next)
      }
    }
    setState(snapshot)
    shared(`sources:${key}`, () => listTerminalSources({ data: { spaceSlug } }))
      .then((infos) => {
        const asked = infos.filter((info) => info.targets === null).map((info) => info.ref.id)
        publish({ infos, expanded: snapshot.expanded, pending: asked })
        for (const id of asked) {
          shared(`targets:${id}`, () => listTerminalSourceTargets({ data: { id } }))
            .catch((): TerminalSourceTarget[] => [])
            .then((targets) =>
              publish({
                ...snapshot,
                expanded: { ...snapshot.expanded, [id]: targets },
                pending: snapshot.pending.filter((pendingId) => pendingId !== id),
              }),
            )
        }
      })
      .catch(() => publish({ ...snapshot, infos: snapshot.infos ?? [], pending: [] }))
    return () => {
      mounted = false
    }
  }, [key, spaceSlug])

  const sources = (state.infos ?? []).map((info) => {
    const targets = info.targets ?? state.expanded[info.ref.id] ?? []
    return listSource(
      info.ref.id,
      describeGraphRef(info.ref),
      targets.map((target) => ({
        target: target.target,
        name: target.label || describeGraphRef(info.ref, target.handleId).detail || '',
      })),
      { loading: state.pending.includes(info.ref.id), showSpace: !spaceSlug },
    )
  })
  return { sources, loading: state.infos === null }
}

/**
 * Every target the sources list, or null while any of them is still being
 * asked: until then a target missing from the list may only be late.
 */
export function listedTargets(sources: TerminalListSource[], loading: boolean): Set<string> | null {
  if (loading || sources.some((source) => source.loading)) {
    return null
  }
  return new Set(sources.flatMap((source) => source.terminals.map((terminal) => terminal.target)))
}

/**
 * Chosen terminal targets -- a router's routes -- grouped by their owner as
 * Terminal List sources, in the order given. `loading` until the owners'
 * names have arrived.
 *
 * A target is unavailable when the caller says so, and also when no source
 * lists it once they have all answered -- the selector's rule for a saved
 * choice. What a host stored when the target was chosen still resolves after
 * the terminal is gone: a stopped container keeps its exec context.
 */
export function useTargetSources(targets: Array<{ target: string; unavailable?: boolean }>): {
  sources: TerminalListSource[]
  loading: boolean
} {
  const live = useTerminalSources()
  const listed = listedTargets(live.sources, live.loading)
  const refsKey = targets.map((entry) => entry.target).join('\n')
  const [described, setDescribed] = useState<Record<string, GraphRefDescription | null> | null>(null)

  useEffect(() => {
    let mounted = true
    const refs = refsKey ? refsKey.split('\n') : []
    const load = () => {
      describeGraphRefs(refs).then((answers) => {
        if (mounted) {
          setDescribed(answers)
        }
      })
    }
    load()
    const unsubscribe = subscribeGraphRefs(load)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [refsKey])

  if (described === null) {
    return { sources: [], loading: targets.length > 0 }
  }
  return { sources: targetSources(targets, described, listed), loading: false }
}

/**
 * useTargetSources' answer from what it has gathered: the owners' descriptions
 * by target, and what the sources list (null while they are still asked).
 */
export function targetSources(
  targets: Array<{ target: string; unavailable?: boolean }>,
  described: Record<string, GraphRefDescription | null>,
  listed: Set<string> | null,
): TerminalListSource[] {
  // Grouped from the routes, not from the owner's terminals: a group of one
  // may be one of several, which is why each keeps its own name.
  const owners: Array<{ id: string; terminals: ListedTerminal[] }> = []
  for (const entry of targets) {
    const { nodeId } = splitTarget(entry.target)
    const terminal = {
      target: entry.target,
      name: described[entry.target]?.detail ?? '',
      unavailable: entry.unavailable || (listed !== null && !listed.has(entry.target)),
    }
    const owner = owners.find((candidate) => candidate.id === nodeId)
    if (owner) {
      owner.terminals.push(terminal)
    } else {
      owners.push({ id: nodeId, terminals: [terminal] })
    }
  }
  return owners.map((owner) => listSource(owner.id, described[owner.terminals[0].target] ?? null, owner.terminals, {}))
}
