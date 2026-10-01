import type { H3Event } from 'nitro/h3'

import { isExtensionId } from '@/app/_authed/(extension-runtime)/_extension-id'
import { ensureFoldersScanned } from '@/app/_authed/(extension-runtime)/_server/extension-folders'

// h3 types context.params as possibly undefined because not every route has
// dynamic segments; a route registered under [extensionId]/... only ever
// dispatches once every segment has matched, so params is always populated
// here -- this documents that instead of asserting it inline at each call site.
//
// Null when the `extensionId` segment is not an extension id: the caller
// answers 404 without reading the disk for a name that cannot be a folder. For
// an id, the folder index is scanned first if this process has not yet, so the
// route serves the folder that stands in for the id -- a local copy, when
// there is one -- and not merely the folder named by it.
export async function extRouteParams(event: H3Event): Promise<Record<string, string> | null> {
  const { params } = event.context
  if (!params) {
    throw new Error('extRouteParams: route matched without dynamic segments')
  }
  if (!isExtensionId(params.extensionId)) {
    return null
  }
  await ensureFoldersScanned()
  return params
}
