'use client'

import { createContext, useContext } from 'react'

// Whether extension loading has finished — successfully or not.
//
// Carried as context rather than as a prop on the node components, because the
// node component map is memoised on the set of node types. Feeding this into
// that map would change its identity the moment loading settles, and the flow
// library remounts every node when that map is replaced — the canvas would jump
// at exactly the moment it is supposed to fill in quietly.
//
// Defaults to `true` so any host that does not provide it behaves as before:
// a type nothing has claimed reads as missing rather than as forever loading.
// An error that should have been a skeleton is noticed; a skeleton that should
// have been an error is not.
export const ExtensionsSettledContext = createContext(true)

export function useExtensionsSettled(): boolean {
  return useContext(ExtensionsSettledContext)
}
