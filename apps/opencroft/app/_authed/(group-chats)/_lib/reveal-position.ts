// The `?at=` a thread's address may carry: the position of the turn a message
// search hit sits in, so the thread opens scrolled to it.
//
// Anything but a whole number is dropped rather than refused. The address is
// typed or pasted by a reader, and a thread that opens at its latest turn is a
// better answer to a mangled `at` than an error page for a link that is
// otherwise good. (The router parses a bare `at=3` to the number 3 before it
// gets here, so a numeric string is not a case to handle.)
export function parseRevealPosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}
