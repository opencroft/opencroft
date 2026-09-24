import { getSessionUser } from '@opencroft/auth/server'
import { terminalSocket } from '@opencroft/terminal/server'
import { defineWebSocketHandler } from 'nitro/h3'

// Terminal WebSocket, served at /api/ws/terminal by Nitro's file-based
// routing. Session handling for the terminal ITSELF lives in
// @opencroft/terminal; this file only decides who may keep the connection.
//
// SESSION COOKIE ONLY, DELIBERATELY. A browser cannot
// put an Authorization header on a WebSocket (the constructor takes no
// headers), so a bearer token can never reach this route from the client that
// actually uses it. Forcing one through would mean a query parameter or an
// abused subprotocol, both of which put the credential in URLs and logs. So
// this checks the same cookie session every page route does, through the same
// getSessionUser the root boundary uses — not a second mechanism to keep in
// sync with the first.
//
// ACCEPT, THEN CLOSE — NOT REJECT THE UPGRADE. crossws's `upgrade` hook can
// throw a Response to refuse the handshake outright, which is the more
// obvious-looking approach and the one tried first here. It does not survive
// this stack: under `vite dev`, websocket requests
// are proxied to the Nitro dev worker through `httpxy`, and that proxy treats
// a non-101 response to an upgrade request as an unhandled failure — it
// crashes the WHOLE process on an unhandled rejection. Reproduced locally: one
// unauthenticated handshake attempt took the entire dev server down.
//
// So the auth check runs in `open`, after the handshake has already succeeded
// at the HTTP level — the proxy sees a normal upgrade and is content — and an
// unauthenticated peer is closed immediately afterward. `terminalSocket.close`
// is safe to call on a peer that never got as far as creating a session; see
// SessionManager.handleSocketClose, which no-ops when it finds none.
//
// GATING THIS DOES NOT CLOSE SHELL ACCESS. Agents reach a shell through
// /mcp (or the in-process tool bridge) → remote_exec → terminal.exec,
// in-process, never through this websocket. This closes the BROWSER path to a
// shell; the other one is closed by /mcp refusing every caller without an MCP
// token, not by anything in this file.
export default defineWebSocketHandler({
  async open(peer) {
    const user = await getSessionUser(peer.request)
    if (!user) {
      // 4401 is in the application-defined close-code range (4000–4999); the
      // 1xxx range is reserved for the protocol itself. Reason strings are not
      // guaranteed to reach the client across every transport, so the client
      // must not depend on it — only on the fact that the socket closed
      // immediately without ever receiving a `connected` message.
      peer.close(4401, 'Unauthorized')
      return
    }
  },
  message(peer, message) {
    terminalSocket.message(peer, message.text())
  },
  close(peer) {
    terminalSocket.close(peer)
  },
})
