import { createServerFn } from '@tanstack/react-start'
import type { BackupInstanceKeys } from 'ui/settings/backup-restore'

import { adminOnly } from '@/app/_authed/(settings)/_server/admin-middleware'
import { instanceKeysStatus } from '@/server/instance-keys'
import { secrets } from '@/server/secrets'

/**
 * Where the instance keys come from, the key file's warning while it is in
 * use, and how many stored secrets the current OPENCROFT_SECRETS_KEY cannot
 * decrypt. Names and a count only: no key value leaves the server.
 */
export const getInstanceKeys = createServerFn({ strict: { output: false } })
  .middleware([adminOnly])
  .handler(async (): Promise<BackupInstanceKeys> => {
    const { sources, keyFile, notice } = instanceKeysStatus()
    return {
      secretsKey: sources.OPENCROFT_SECRETS_KEY,
      authSecret: sources.OPENCROFT_AUTH_SECRET,
      keyFile,
      notice: notice ?? undefined,
      undecryptableSecrets: await secrets.countUndecryptable(),
    }
  })
