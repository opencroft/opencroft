'use client'

import { createContext, useContext } from 'react'

export interface ExtensionsState {
  /** Whether extension loading has finished — successfully or not. */
  settled: boolean
  /**
   * Bumped every time the registry's contents change.
   *
   * It is carried here for its identity, not for its value: nothing reads the
   * number. A node component resolves itself from the registry during render,
   * and the registry is not reactive — so something has to tell React that the
   * answer may have changed. This does, by changing the context value, which
   * re-renders every node wrapper.
   *
   * That is the whole mechanism by which a node fills in once its extension
   * arrives, and it re-renders the node rather than remounting it.
   */
  version: number
}

/**
 * Whether the extension registry is settled, and a token that changes whenever
 * it is written to.
 *
 * Carried as context rather than through the node-type map: that map holds one
 * fixed wrapper per node type (see buildNodeTypes), which cannot carry a value
 * that changes.
 *
 * Defaults to settled so any host that does not provide it behaves as before:
 * a type nothing has claimed reads as missing rather than as forever loading.
 * An error that should have been a skeleton is noticed; a skeleton that should
 * have been an error is not.
 */
export const ExtensionsStateContext = createContext<ExtensionsState>({ settled: true, version: 0 })

export function useExtensionsSettled(): boolean {
  return useContext(ExtensionsStateContext).settled
}
