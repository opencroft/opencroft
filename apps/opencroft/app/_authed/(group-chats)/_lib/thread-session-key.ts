// Row id -> session key, for the thread list.
//
// The kit's thread list identifies a row by THREAD id and says so explicitly:
// it knows nothing about sessions, and the host holds the mapping. Everything
// in the agent layer is keyed by session key instead. Both are plain strings,
// so handing one where the other belongs compiles cleanly and then does
// nothing at runtime — the call reaches a key that matches no session, no
// error is raised, and the button simply appears not to work.
//
// That failure is invisible to a type checker, which is the whole reason this
// is a named function with a test rather than an inline `.find` at the call
// site.
export function threadSessionKey(
  threads: ReadonlyArray<{ id: string; sessionKey: string }>,
  threadId: string,
): string | undefined {
  return threads.find((thread) => thread.id === threadId)?.sessionKey
}
