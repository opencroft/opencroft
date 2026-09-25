// Where the transcript draws a stored picture from: the Nitro route in
// server/routes/api/acp/attachments (an <img> cannot reach a TanStack server
// route under vite dev -- see that file), scoped by the conversation's session
// key the same way delivery is. The key is the one the picture was stored under --
// the tab key the composer uploaded with.
export function attachmentSrc(sessionKey: string, id: string): string {
  return `/api/acp/attachments/${encodeURIComponent(id)}?key=${encodeURIComponent(sessionKey)}`
}
