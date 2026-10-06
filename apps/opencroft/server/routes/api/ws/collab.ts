import type { Hocuspocus } from '@hocuspocus/server'
import { defineWebSocketHandler } from 'nitro/h3'

import { getCollabServer } from '@/server/collab/collab-server'
import { ensureServerStarted } from '@/server/startup'

// Collaboration WebSocket, served at /api/ws/collab: the Yjs sync protocol for
// every collaboratively edited document, spoken by Hocuspocus.
//
// A peer's messages are held until the server has started and the connection
// exists. After a restart an open page reconnects at once, possibly before any
// request has started the server, and the document types are registered at
// startup; and sync messages arrive right behind the handshake, so one that
// reached `message` before the connection would be lost. Hocuspocus itself
// then holds them until its onAuthenticate accepts the connection -- which is
// where the session cookie is checked (see collab-server.ts), so the handshake
// is never refused at the HTTP level, for the reason given in terminal.ts.

type ClientConnection = ReturnType<Hocuspocus['handleConnection']>

interface PeerState {
  connection?: ClientConnection
  held: Uint8Array[]
  closed?: { code: number; reason: string }
}

const peers = new WeakMap<object, PeerState>()

export default defineWebSocketHandler({
  open(peer) {
    const state: PeerState = { held: [] }
    peers.set(peer, state)
    void ensureServerStarted().then(() => {
      if (state.closed) {
        return
      }
      // crossws types the socket as Partial<WebSocket>; under Node it is the
      // whole `ws` socket, the same object Hocuspocus's own server passes here.
      state.connection = getCollabServer().handleConnection(peer.websocket as WebSocket, peer.request)
      for (const message of state.held.splice(0)) {
        state.connection.handleMessage(message)
      }
    })
  },
  message(peer, message) {
    const state = peers.get(peer)
    if (state?.connection) {
      state.connection.handleMessage(message.uint8Array())
    } else {
      state?.held.push(message.uint8Array())
    }
  },
  close(peer, event) {
    const state = peers.get(peer)
    if (state) {
      state.closed = { code: event.code ?? 1000, reason: event.reason ?? '' }
      state.connection?.handleClose(state.closed)
    }
    peers.delete(peer)
  },
})
