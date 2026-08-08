'use client'

// Temporary diagnostic instrumentation for the empty extension-mode launcher
// investigation. Records registry and keyboard-handler activity onto
// window.__extDebug so a live browser session can be inspected directly,
// independent of whatever the console does or doesn't surface. Remove once
// the root cause is confirmed.

export interface DebugProbeState {
  registerCalls: Array<{ extensionId: string; commandModeIdsAfter: string[]; at: number }>
  overlayRenders: Array<{ extensionsVersion: number; commandModeIds: string[]; at: number }>
  keydowns: Array<{
    code: string
    commandModeIdsAtKeydown: string[]
    matchedModeId: string | null
    at: number
  }>
  snapshot: () => { commandModeIds: string[]; extensionIds: string[] }
}

function state(): DebugProbeState | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  const w = window as unknown as { __extDebug?: DebugProbeState }
  w.__extDebug = w.__extDebug ?? {
    registerCalls: [],
    overlayRenders: [],
    keydowns: [],
    snapshot: () => ({ commandModeIds: [], extensionIds: [] }),
  }
  return w.__extDebug
}

// Wired up once by registry.ts (the only module that can read live registry
// state without going through a render) so a probe can pull the registry's
// CURRENT contents on demand, not just what's been recorded so far.
export function setSnapshotFn(fn: () => { commandModeIds: string[]; extensionIds: string[] }): void {
  const s = state()
  if (s) {
    s.snapshot = fn
  }
}

export function recordRegisterCall(extensionId: string, commandModeIdsAfter: string[]): void {
  state()?.registerCalls.push({ extensionId, commandModeIdsAfter, at: Date.now() })
}

export function recordOverlayRender(extensionsVersion: number, commandModeIds: string[]): void {
  state()?.overlayRenders.push({ extensionsVersion, commandModeIds, at: Date.now() })
}

export function recordKeydown(code: string, commandModeIdsAtKeydown: string[], matchedModeId: string | null): void {
  state()?.keydowns.push({ code, commandModeIdsAtKeydown, matchedModeId, at: Date.now() })
}
