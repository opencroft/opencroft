import { createServerFn } from '@tanstack/react-start'

import { adminOnly } from '@/app/_authed/(settings)/_server/admin-middleware'
import {
  planTypeReplacement,
  type ReplacePlan,
  type ReplaceRequest,
  type ReplaceResult,
  replaceType,
  scanUnknownTypes,
  type TypeScan,
} from '@/app/_authed/(settings)/_server/unknown-types'

function replaceRequest(input: ReplaceRequest): ReplaceRequest {
  const { kind, from, to } = input ?? {}
  if ((kind !== 'node' && kind !== 'app') || typeof from !== 'string' || typeof to !== 'string' || !from || !to) {
    throw new Error('Expected { kind: "node" | "app", from, to }')
  }
  return { kind, from, to }
}

export const listUnknownTypes = createServerFn({ strict: { output: false } })
  .middleware([adminOnly])
  .handler(async (): Promise<TypeScan> => scanUnknownTypes())

export const planUnknownTypeReplacement = createServerFn({ method: 'POST', strict: { output: false } })
  .middleware([adminOnly])
  .inputValidator(replaceRequest)
  .handler(async ({ data }): Promise<ReplacePlan> => planTypeReplacement(data))

export const replaceUnknownType = createServerFn({ method: 'POST', strict: { output: false } })
  .middleware([adminOnly])
  .inputValidator(replaceRequest)
  .handler(async ({ data }): Promise<ReplaceResult> => replaceType(data))
