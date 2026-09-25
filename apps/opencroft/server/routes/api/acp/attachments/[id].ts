import { defineEventHandler } from 'nitro/h3'

import { attachmentResponse } from '@/app/_authed/(agent)/_server/attachment-response'

// A stored chat picture, at /api/acp/attachments/<id>?key=<sessionKey> -- the
// src the transcript gives every picture a message carried.
//
// A NITRO ROUTE, NOT A TANSTACK ONE, because an <img> has to reach it. Under
// `vite dev` (the dev server), Nitro's dev middleware decides per request
// whether a URL is the app or a static asset, and for anything that is not a
// route of its own it asks the browser: a request whose Sec-Fetch-Dest is
// neither `document`/`iframe`/`frame` nor `empty` is taken for an asset and
// handed to Vite's static serving. Every <img> sends `image`. So as a TanStack
// server route this answered a fetch() (`empty`) and 404'd "Cannot GET" to
// every picture actually drawn. A route in this directory is matched by Nitro
// before that guess is made, whatever the request's destination -- the same
// reason the extension bundle routes beside it live here.
// attachment-routing.test.ts holds the line.
export default defineEventHandler((event) => {
  const id = event.context.params?.id
  if (!id) {
    return new Response('Not found', { status: 404 })
  }
  return attachmentResponse(event.req, id)
})
