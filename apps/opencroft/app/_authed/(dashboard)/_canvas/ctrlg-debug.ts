// TEMPORARY diagnostic scaffolding for an intermittent Ctrl+G
// failure (~1/3 success rate, silent, no console errors). Reverts once the
// mechanism is confirmed.
//
// Three independent signals, correlated by timestamp, to distinguish the
// live hypotheses without guessing:
// 1. `captured`: every ctrl/meta keydown seen at the CAPTURE phase on
//    window -- proves whether the event reaches window at all, and via
//    what DOM path, regardless of what canvas-overlay's own bubble-phase
//    listener does with it.
// 2. `bubbled`: every ctrl/meta keydown canvas-overlay's own `onKey` (bubble
//    phase) actually receives, plus what extensionModes it matched against
//    -- proves whether the listener fires at all, and whether it fires with
//    a stale/empty mode list.
// 3. `reloads`: every extension-registry clear/settle from flow-editor's
//    SSE-driven reload effect -- extensions are global (any agent's
//    compile_extension anywhere bumps this), so a failed attempt landing
//    inside one of these windows would be a real, reproducible mechanism
//    distinct from anything client-load-order related.

interface CapturedEntry {
  at: number
  code: string
  target: string
  composedPath: string[]
  defaultPrevented: boolean
}

interface BubbledEntry {
  at: number
  code: string
  extensionModeIds: string[]
  matched: string | null
}

interface ReloadEntry {
  at: number
  phase: 'clear' | 'settled'
  version?: number
}

// Round 2: bubbled/captured/reloads came back identical on pass vs fail, which
// eliminates event-delivery and the SSE-reload race -- the match happens every
// time. So the remaining question is what happens to `mode` state AFTER the
// match, between activateMode(matched) being called and the overlay actually
// painting. `managerCalls` records every mode transition regardless of which
// caller triggered it (activate/dismiss/a bare setMode all funnel through one
// wrapped setter in overlay-context.ts), so an unexplained transition back
// off 'git-client' shows up here even if its caller isn't one we guessed at.
// `renders` records CanvasOverlay's own mode/overlayActive on every render, to
// see whether mode ever reverts before the content slot is ever painted.
interface ManagerCallEntry {
  at: number
  prevMode: string
  nextMode: string
}

interface RenderEntry {
  at: number
  mode: string
  hasActiveExtMode: boolean
  overlayActive: boolean
}

const captured: CapturedEntry[] = []
const bubbled: BubbledEntry[] = []
const reloads: ReloadEntry[] = []
const managerCalls: ManagerCallEntry[] = []
const renders: RenderEntry[] = []

export function recordCaptured(e: KeyboardEvent): void {
  captured.push({
    at: Date.now(),
    code: e.code,
    target: (e.target as HTMLElement | null)?.tagName ?? String(e.target),
    composedPath: e.composedPath().map((t) => (t as HTMLElement)?.tagName ?? String(t)),
    defaultPrevented: e.defaultPrevented,
  })
}

export function recordBubbled(code: string, extensionModeIds: string[], matched: string | null): void {
  bubbled.push({ at: Date.now(), code, extensionModeIds, matched })
}

export function recordReloadClear(): void {
  reloads.push({ at: Date.now(), phase: 'clear' })
}

export function recordReloadSettled(version: number): void {
  reloads.push({ at: Date.now(), phase: 'settled', version })
}

export function recordManagerCall(prevMode: string, nextMode: string): void {
  managerCalls.push({ at: Date.now(), prevMode, nextMode })
}

export function recordRender(mode: string, hasActiveExtMode: boolean, overlayActive: boolean): void {
  renders.push({ at: Date.now(), mode, hasActiveExtMode, overlayActive })
}

;(globalThis as Record<string, unknown>).__ctrlGDebug = {
  captured,
  bubbled,
  reloads,
  managerCalls,
  renders,
  snapshot: () => ({
    captured: [...captured],
    bubbled: [...bubbled],
    reloads: [...reloads],
    managerCalls: [...managerCalls],
    renders: [...renders],
  }),
}
