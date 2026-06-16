import { React } from '@ext/host'

export interface ScriptResult {
  stdout: string
  stderr: string
  exitCode: number
}

const store = new Map<string, ScriptResult>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) {
    l()
  }
}

export function setScriptResult(nodeId: string, result: ScriptResult | null): void {
  if (result === null) {
    store.delete(nodeId)
  } else {
    store.set(nodeId, result)
  }
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useScriptResult(nodeId: string): ScriptResult | null {
  return React.useSyncExternalStore(
    subscribe,
    () => store.get(nodeId) ?? null,
    () => null,
  )
}
