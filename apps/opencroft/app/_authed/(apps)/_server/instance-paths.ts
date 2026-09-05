// One address, importable from both the app-instance runtime and the
// extension host API without dragging either's dependencies along.

import { dataDir } from '@/server/data-dir'

/** Absolute path of one App instance's private data directory. */
export function appInstanceDataDir(extensionId: string, instanceId: string): string {
  return dataDir('app-data', extensionId, instanceId)
}
