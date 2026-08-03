// The group-chat refusal type, on its own and depending on nothing.
//
// It lives here rather than in model.ts because both sides of the RPC
// boundary need it: the server throws it, and the client has to recognise it.
// While it sat in model.ts, importing it at runtime meant importing the
// database and the ACP session machinery behind it — so anything reachable
// from the browser that wanted to name this class would have dragged that tail
// with it, which is a failure mode that can take the server down
// (a plain export beside a createServerFn keeps the file's imports alive in
// the client build). A dependency-free module cannot cause that.
//
// model.ts re-exports both names, so existing server-side callers are
// unchanged.

export type GroupChatAccessFailure =
  /** Not signed in, or signed in as nobody this system recognises. */
  | 'unauthenticated'
  /**
   * The request names a group chat or thread that this caller cannot have —
   * because it does not exist, OR because they are not a member. **Those two
   * are one code and one message on purpose, and there is no longer a
   * `not-a-member` to tell them apart.**
   *
   * There used to be. The screen mapped both to identical copy, which looked
   * like enough and was not: a browser console capture showed
   * the raw refusal on the wire — `No such group chat` for a fabricated id,
   * `You are not a member of this group chat` for a real one. Any client
   * reading the response, rather than the screen, could tell which ids were
   * real. The identical copy was masking a distinction that was still being
   * transmitted.
   *
   * So the collapse is here, at the point the refusal is created, and the
   * client-side mapping is belt-and-braces rather than the thing holding the
   * property up. Emitting a distinguishable refusal for these two cases is a
   * defect, not a style choice.
   */
  | 'not-found'
  /**
   * The request names an agent that is not a member of the group chat.
   *
   * Distinct on purpose and not part of the collapse above: reaching this
   * requires already being a member of the group chat in question, so it
   * cannot tell an outsider which ids are real.
   */
  | 'agent-not-a-member'

/**
 * PHASE 2 CONTRACT, verified against the actual wire format rather than
 * assumed: `createServerFn` sends a thrown error through seroval's
 * `toCrossJSONAsync` / `fromCrossJSON`, which reconstructs it as a plain
 * `Error` — a custom subclass is not in seroval's fixed constructor list, so
 * **`instanceof GroupChatAccessError` is false on the client even for one of
 * these.** `name` and every other own-enumerable property (so `code`) DO
 * survive, copied onto that plain `Error`.
 *
 * So: client code must branch on `error.name === 'GroupChatAccessError'` and
 * then read `.code` — never on `instanceof`. `_lib/group-chat-error.ts` is the
 * helper that does this, and its test proves the round trip rather than
 * assuming it. `model.test.ts`'s `instanceof` checks remain correct as
 * written; they call the model directly and never cross the boundary.
 */
export class GroupChatAccessError extends Error {
  constructor(
    readonly code: GroupChatAccessFailure,
    message: string,
  ) {
    super(message)
    this.name = 'GroupChatAccessError'
  }
}
