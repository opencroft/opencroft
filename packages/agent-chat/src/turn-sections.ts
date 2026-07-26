// A user message plus everything the agent produced in reply to it.
// Only `id` and the `kind` discriminant are constrained — hosts differ in the
// rest of their block shape (and in whether ids are strings or numbers), and
// the grouping doesn't need to know. 'user' is the only kind it reads; every
// other kind is a reply belonging to the turn above it.
export interface TurnSection<T extends { id: string | number; kind: string }> {
  // The id of the block the section starts at — stable across "load older"
  // prepends for the same reason block ids are.
  id: T['id']
  // Narrowed to the user variant so call sites can read its own fields (text,
  // and whatever else the host's block type carries) without re-narrowing.
  //
  // Absent only for a section the render window cut into: a window can start
  // partway through a turn, leaving reply blocks with no user message above
  // them. Such a section renders without a sticky header rather than
  // borrowing the previous turn's.
  user?: Extract<T, { kind: 'user' }>
  items: T[]
}

// Groups a flat block list into one section per turn, so a turn's user message
// can be rendered as a `position: sticky` header over its own replies. The
// section boundary is what makes the next user message push the previous one
// out of the viewport: each header is constrained to its own section's box, so
// no scroll listener or offset arithmetic is involved.
export function groupIntoTurnSections<T extends { id: string | number; kind: string }>(blocks: T[]): TurnSection<T>[] {
  const sections: TurnSection<T>[] = []
  for (const block of blocks) {
    if (block.kind === 'user') {
      // A discriminant check doesn't narrow a generic parameter, so the cast
      // stands in for it — asserted once here rather than at every call site.
      sections.push({ id: block.id, user: block as Extract<T, { kind: 'user' }>, items: [] })
      continue
    }
    const current = sections[sections.length - 1]
    if (current) {
      current.items.push(block)
    } else {
      sections.push({ id: block.id, items: [block] })
    }
  }
  return sections
}
