import { type HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'

import { STALE_LINEAGE_REASON } from '@/lib/collab-protocol'

/**
 * Keeps a shared document's connection through the server closing the
 * document, which it does to change the document's storage -- a discard, a
 * delete, a pull. The server tells each client that document is closed and
 * leaves the socket open; the provider (Hocuspocus 4.7) takes that as the end
 * of its session with the document and never authenticates again by itself,
 * so an editor would go on looking live while nothing typed in it reached
 * anyone.
 *
 * So it authenticates again at once, and the server holds that until the
 * change is done. When the change left the document as this copy holds it,
 * the same lineage is let back in and what was typed meanwhile is sent then;
 * when the change rebuilt the document, the lineage is refused as stale and
 * `onStale` opens a fresh copy -- as it does for any stale refusal.
 *
 * Returns what stops it.
 */
export function stayConnected(provider: HocuspocusProvider, { onStale }: { onStale: () => void }): () => void {
  const onClose = () => {
    // A socket that closed reconnects, and authenticates, on its own: by the
    // time its close reaches the provider the socket is no longer connected.
    if (provider.configuration.websocketProvider.status === WebSocketStatus.Connected) {
      void provider.sendToken().then(() => provider.startSync())
    }
  }
  const onAuthenticationFailed = ({ reason }: { reason: string }) => {
    if (reason === STALE_LINEAGE_REASON) {
      onStale()
    }
  }
  provider.on('close', onClose)
  provider.on('authenticationFailed', onAuthenticationFailed)
  return () => {
    provider.off('close', onClose)
    provider.off('authenticationFailed', onAuthenticationFailed)
  }
}
