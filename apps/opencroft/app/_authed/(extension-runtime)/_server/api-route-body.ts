/** What an API Route's request event carries of the request's body. */
export interface RequestBody {
  /** The parsed JSON for a JSON content type (absent when it does not parse), else the body's text. */
  body?: unknown
  /** The body's text whenever it is not JSON, a JSON body that does not parse included. */
  text?: string
}

/**
 * Reads `request`'s body once, for the route's event: nothing for GET and
 * HEAD, which carry none.
 */
export async function requestBody(request: Request): Promise<RequestBody> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return {}
  }
  const raw = await request.text()
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return { body: raw, text: raw }
  }
  try {
    return { body: JSON.parse(raw) }
  } catch {
    return { text: raw }
  }
}
