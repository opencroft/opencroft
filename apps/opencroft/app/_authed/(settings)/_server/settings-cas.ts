import { getSettingImpl, setSettingImplCas } from './settings-impl'

// Read-modify-write against a settings row's JSON blob is only safe under
// concurrent writers if every writer goes through this. Two layers, same
// reasoning as host.ts's extension storage (generalised here
// for the session-store writes):
//   - an in-process mutex per settings row id, serializing every mutation
//     against that row within this one process -- the case that actually
//     matters, since we run a single Node process;
//   - a version-CAS retry underneath, so a writer that somehow still lands
//     concurrently (a second process, a bug in the mutex) can't silently
//     win -- its CAS fails and it re-reads and retries instead of
//     overwriting a write it never saw.
const settingLocks = new Map<string, Promise<void>>()

export function withSettingLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prior = settingLocks.get(id) ?? Promise.resolve()
  const result = prior.then(fn, fn)
  settingLocks.set(
    id,
    result.then(
      () => undefined,
      () => undefined,
    ),
  )
  return result
}

const MAX_CAS_ATTEMPTS = 5

// `mutate` receives the row's current data ({} for one that doesn't exist
// yet) and returns the next data to persist. Returning the exact same
// reference it was given is a no-op: nothing is written, no version spent --
// lets a caller fold an "nothing actually changed" check into the mutate
// step itself instead of racing a separate read beforehand.
export async function mutateSettingData(
  id: string,
  mutate: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const row = await getSettingImpl(id)
    const current = row?.data ?? {}
    const nextData = mutate(current)
    if (nextData === current) {
      return
    }
    const result = await setSettingImplCas({ id, data: nextData, expectedVersion: row?.version ?? 0 })
    if (result) {
      return
    }
    // Lost the CAS race to a concurrent writer -- loop to re-read a fresh
    // snapshot and retry, rather than overwriting what it wrote.
  }
  throw new Error(`Settings write to '${id}' lost the update race ${MAX_CAS_ATTEMPTS} times in a row`)
}
