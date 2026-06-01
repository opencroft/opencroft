export interface TextChunk {
  text: string
  final: boolean
}

export interface Stream<T> {
  subscribe(fn: (chunk: T) => void): () => void
  broadcast(chunk: T): void
}

class StreamImpl<T> implements Stream<T> {
  private handlers = new Set<(chunk: T) => void>()

  subscribe(fn: (chunk: T) => void): () => void {
    this.handlers.add(fn)
    return () => {
      this.handlers.delete(fn)
    }
  }

  broadcast(chunk: T): void {
    for (const handler of this.handlers) {
      handler(chunk)
    }
  }
}

const registry = new Map<string, StreamImpl<unknown>>()

function keyFor(nodeId: string, handleId: string): string {
  return `${nodeId}::${handleId}`
}

export function getStream<T>(nodeId: string, handleId: string): Stream<T> {
  const key = keyFor(nodeId, handleId)
  let impl = registry.get(key)
  if (!impl) {
    impl = new StreamImpl<unknown>()
    registry.set(key, impl)
  }
  return impl as unknown as Stream<T>
}

export function subscribe<T>(stream: Stream<T>, fn: (chunk: T) => void): () => void {
  return stream.subscribe(fn)
}

export function broadcast<T>(stream: Stream<T>, chunk: T): void {
  stream.broadcast(chunk)
}
