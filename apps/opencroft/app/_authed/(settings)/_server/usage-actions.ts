import { createServerFn } from '@tanstack/react-start'

import {
  type ChatUsageAnswer,
  type ChatUsageQuery,
  queryInstanceChatUsage,
} from '@/app/_authed/(agent)/_server/chat-usage-store'
import { adminOnly } from '@/app/_authed/(settings)/_server/admin-middleware'

// Administration's Usage section: the spend of the whole instance, every
// space's and the turns in none. It reads across every space, so only an
// administrator may call it. There is no reset here: each space resets its
// own from its settings.
export const getInstanceUsage = createServerFn({ method: 'GET', strict: { output: false } })
  .middleware([adminOnly])
  .inputValidator((query: ChatUsageQuery) => query)
  .handler(async ({ data }): Promise<ChatUsageAnswer> => {
    return queryInstanceChatUsage(data.grouping, data.period, data.chosen)
  })
