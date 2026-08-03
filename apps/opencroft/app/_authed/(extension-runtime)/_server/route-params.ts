import type { H3Event } from 'nitro/h3'

// h3 types context.params as possibly undefined because not every route has
// dynamic segments; a route registered under [scope]/[slug]/... only ever
// dispatches once every segment has matched, so params is always populated
// here -- this documents that instead of asserting it inline at each call site.
export function extRouteParams(event: H3Event): Record<string, string> {
  const { params } = event.context
  if (!params) {
    throw new Error('extRouteParams: route matched without dynamic segments')
  }
  return params
}
