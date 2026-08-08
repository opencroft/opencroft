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
  activateCalls: Array<{ mode: string; hasParams: boolean; at: number }>
  dismissCalls: Array<{ at: number }>
  slotWrites: Array<{ slot: string; hasNode: boolean; at: number }>
  overlayContentSeen: Array<{ mode: string; hasContent: boolean; aiChatActive: boolean; at: number }>
  contentRenderErrors: Array<{ message: string; componentStack: string | null; at: number }>
  snapshot: () => { commandModeIds: string[]; extensionIds: string[] }
  overlayContainerHtml: () => string | null
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
    activateCalls: [],
    dismissCalls: [],
    slotWrites: [],
    overlayContentSeen: [],
    contentRenderErrors: [],
    snapshot: () => ({ commandModeIds: [], extensionIds: [] }),
    overlayContainerHtml: () => null,
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

// Wired up by canvas-overlay.tsx from the overlay's own container ref, so a
// probe can read the ACTUAL painted markup on demand rather than guessing a
// CSS selector from outside.
export function setOverlayContainerHtmlFn(fn: () => string | null): void {
  const s = state()
  if (s) {
    s.overlayContainerHtml = fn
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

export function recordActivate(mode: string, hasParams: boolean): void {
  state()?.activateCalls.push({ mode, hasParams, at: Date.now() })
}

export function recordDismiss(): void {
  state()?.dismissCalls.push({ at: Date.now() })
}

export function recordSlotWrite(slot: string, hasNode: boolean): void {
  state()?.slotWrites.push({ slot, hasNode, at: Date.now() })
}

export function recordOverlayContentSeen(mode: string, hasContent: boolean, aiChatActive: boolean): void {
  state()?.overlayContentSeen.push({ mode, hasContent, aiChatActive, at: Date.now() })
}

export function recordContentRenderError(message: string, componentStack: string | null): void {
  state()?.contentRenderErrors.push({ message, componentStack, at: Date.now() })
}
