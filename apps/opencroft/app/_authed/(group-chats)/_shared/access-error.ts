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
   *
   * ONE PLACE DOES NOT REFUSE AT ALL, and it is not an exception to the above:
   * a space's own embedded chat offers a non-member a Join control instead,
   * by design. It reaches that decision
   * without this code — `resolveGroupChatBySlug` answers in states rather than
   * refusals, and its own comment carries the reasoning, including why the
   * existence it discloses was already observable through the create path.
   * Everything that still throws a refusal still collapses into this.
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
   * The request would remove the last person from a group chat.
   *
   * Also outside the collapse, and for the same reason: only a member can
   * reach it, so it tells an outsider nothing. It is a refusal of a specific
   * action rather than of access, and the caller needs to be able to say why
   * the Remove they pressed did nothing.
   */
  | 'last-user-member'
  /**
   * A chat already holds as many pins as it may.
   *
   * Outside the collapse for the same reason as the two above: only a member
   * can reach it, and the person who pressed Pin needs to be told that the
   * limit is why nothing happened — "that didn't work" would send them
   * looking for a fault that is not there.
   */
  | 'pin-limit'
  /**
   * The slug this name or title would take is already in use.
   *
   * A refusal rather than a silent rename: the slug is the readable half of a
   * session key, the person chose the words it comes from, and quietly handing
   * them `-2` would mean the key no longer says what they typed. They can pick
   * again.
   */
  | 'slug-taken'
  /**
   * There is nothing in this name or title to build a slug from — it is all
   * punctuation, or emoji. Distinct from `slug-taken`: the answer is different
   * words, not different from someone else's.
   */
  | 'slug-unusable'
  /**
   * The thread is there and the caller may have it — the MESSAGE the request
   * named is not where it said. A screen names a turn by its position in the
   * session's event log, and a session that was reloaded underneath an open
   * tab (the idle reaper stops quiet agents) can hand back a log the tab's
   * positions no longer describe.
   *
   * Outside the collapse into `not-found`, and this one is not a security
   * nicety but the whole point: it is reached only from a thread the caller
   * has already been granted, and telling them "this group chat is not
   * available" about a chat plainly on their screen sends them to look for a
   * fault that is not there. What they need to be told is to reload.
   */
  | 'turn-not-found'
  /**
   * The thread is archived, and an archived thread takes no messages from
   * anyone until it is unarchived. Outside the collapse for the reason the
   * codes above share: only a caller who may already have the thread gets this
   * far, and they need to be told to unarchive it, not that it is missing.
   */
  | 'thread-archived'
  /**
   * The message's text is over the limit one message may carry (see
   * `(agent)/_shared/message-size.ts`). Refused before the thread is created
   * or the message queued, whoever sent it. Outside the collapse because only
   * a caller who may write here gets this far, and they need to know the
   * size is why nothing was sent.
   */
  | 'message-too-large'

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
 * helper that does this. `model.test.ts`'s `instanceof` checks remain correct
 * as written; they call the model directly and never cross the boundary.
 *
 * CORRECTED, and the correction is the important part: the paragraph above
 * describes seroval, not the boundary. A thrown server-function error does NOT
 * reach the browser with its properties — the real payload was captured as
 * `{"message":"…"},"c":"$TSR/Error"}`, a plain Error with its message and
 * nothing else. `name` and `code` are both gone, so the helper cannot identify
 * a refusal that was thrown out of a `createServerFn`, and every one of them
 * falls through to whatever the caller's fallback copy is. That shipped once.
 *
 * The rule that follows: **if the browser has to know WHICH refusal it was,
 * return it as data** — a discriminated result carrying the code — and keep
 * throwing for faults only. Matching on the message text is not a substitute;
 * it works until the first copy edit. See `_server/actions.ts`'s
 * `SendThreadMessageResult` for the shape.
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
