// Shared rewind logic for forking a conversation. Given the positions of the
// user messages/events and the turn to drop from (0-based; defaults to the last
// turn), returns the index to slice at — everything from that user turn onward
// is dropped. Returns null when there are no turns to drop.

export function findTurnBoundary(userIndices: number[], dropFromTurn?: number): number | null {
  if (userIndices.length === 0) {
    return null
  }
  const turn = dropFromTurn ?? userIndices.length - 1
  const clamped = Math.max(0, Math.min(turn, userIndices.length - 1))
  return userIndices[clamped]
}
