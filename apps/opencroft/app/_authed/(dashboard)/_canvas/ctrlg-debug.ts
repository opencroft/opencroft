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

const captured: CapturedEntry[] = []
const bubbled: BubbledEntry[] = []
const reloads: ReloadEntry[] = []

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

;(globalThis as Record<string, unknown>).__ctrlGDebug = {
  captured,
  bubbled,
  reloads,
  snapshot: () => ({ captured: [...captured], bubbled: [...bubbled], reloads: [...reloads] }),
}
