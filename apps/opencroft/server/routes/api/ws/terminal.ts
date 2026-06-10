import { terminalSocket } from '@opencroft/terminal/server'
import { defineWebSocketHandler } from 'nitro/h3'

// Terminal WebSocket, served at /api/ws/terminal by Nitro's file-based routing.
// Session handling lives in @opencroft/terminal.
export default defineWebSocketHandler({
  message(peer, message) {
    terminalSocket.message(peer, message.text())
  },
  close(peer) {
    terminalSocket.close(peer)
  },
})
