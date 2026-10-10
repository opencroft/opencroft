/**
 * `@opencroft/client/streams` — live values between nodes and from the
 * extension's server: a node output's stream, and the extension's `events`
 * stream that the server half's `events.broadcast` feeds.
 */

export interface TextChunk {
  text: string
  final: boolean
}

export interface Stream<T> {
  subscribe(fn: (chunk: T) => void): () => void
  broadcast(chunk: T): void
}

/**
 * The stream of `handleId` on `nodeId`. The extension's own server events
 * arrive on `getStream(extensionId, 'events')`.
 */
export declare const getStream: <T>(nodeId: string, handleId: string) => Stream<T>
export declare const subscribe: <T>(stream: Stream<T>, fn: (chunk: T) => void) => () => void
export declare const broadcast: <T>(stream: Stream<T>, chunk: T) => void
