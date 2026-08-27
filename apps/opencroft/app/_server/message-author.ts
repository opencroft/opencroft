import { AGENT_NODE_TYPE } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { currentUsername, ensureUsernameForAgent, ensureUsernameForUser } from '@/app/_server/usernames'

/**
 * Who a message is from — one answer for both kinds of sender.
 *
 * A GRAPH-DRIVEN message is attributed from what actually fed the run; a
 * PERSON'S message is attributed from the account that is signed in. They live
 * together because they produce the same thing: the durable identifier that
 * goes into the delivery, never a display name. A display name is not an
 * identity — two accounts can share one, and a rename silently reattributes
 * every message already written under it — so what is stamped is the handle,
 * and what a reader sees is whatever that handle resolves to now.
 *
 * The graph half, in detail:
 *
 * A SEAM WITH FOLLOW-UP WORK BEHIND IT. The originator is threaded only as far as
 * the send, from the one place each entry point already knows it; nothing else
 * in the execution chain learns about originators. When the exec context
 * carries an originator of its own, this is replaced -- it is written to be
 * lifted out whole rather than unpicked, which is why the mapping lives here
 * and not spread through the callers.
 *
 * THE SOURCE NODE IS NOT AN IDENTITY. Knowing which node fed the run is the
 * first step; turning that into an account is a second one, and it is exact or
 * it refuses. There is deliberately no "probably an agent" branch: a guess here
 * is indistinguishable from the tool name it replaces, because both are a
 * string nobody checked.
 */

/**
 * Node types that are known NOT to be an agent, and what the application calls
 * itself when one of them speaks.
 *
 * An allow-list rather than "anything that is not an agent", so a node type
 * nobody considered refuses instead of silently becoming the system. What
 * follows the prefix names the kind of trigger, so a reader can tell a webhook
 * from a schedule without leaving the message.
 *
 * EVERY ENTRY ANSWERS ONE QUESTION: what TRIGGERED this run. A node that merely
 * transformed the text on its way -- something fed it, and it passed something
 * on -- is not the author of the message, and naming it one reports the
 * transport and calls it the sender, which is the mistake this whole guard
 * exists to remove. A transformer in the immediate-source position therefore
 * refuses like anything else unclassified. Walking back through it to the run's
 * actual origin is a different mechanism and belongs with the exec context, not
 * here.
 *
 * BUILT FROM A SWEEP, NOT FROM REASONING ABOUT TYPES. Deriving this list from
 * which node types sound like triggers is the same move as reading a config to
 * learn what runs: it produced a list containing a type with no live instances
 * while missing one carrying the wiring the team depends on. Live entries below
 * are what actually feeds a send-message node, and a sweep is a measurement
 * with a date on it rather than a fact: every space was checked again on
 * 2026-08-27 and the counts had already moved. The rest are anticipatory and
 * are marked so, because an entry nobody has exercised is a guess with good
 * manners.
 */
const SYSTEM_AUTHOR_BY_NODE_TYPE: Record<string, string> = {
  // Live. Delivers forge notifications into the team's threads; one wiring.
  'gitea-webhook-handler': 'system.webhook',
  // Live, and the most exercised path here: four wirings as of 2026-08-27, one
  // of them a schedule firing every ten minutes.
  'script-node': 'system.script',
  // Anticipatory: no wiring feeds a send-message node through these today.
  // They are genuine triggers, so they are listed rather than left to refuse,
  // but nothing here has been exercised by a real delivery.
  'api-route': 'system.route',
  event: 'system.schedule',
  'script-bash': 'system.script',
  'script-python': 'system.script',
}

/** Refused rather than attributed: the caller turns this into its own failure. */
export class UnattributableSendError extends Error {}

/**
 * What the send-message machinery calls itself when it speaks in its own
 * voice — today, only to say that it refused something.
 *
 * In the same namespace as the trigger identifiers above and deliberately not
 * one of them: those name what fed a run, and this names the application
 * talking ABOUT a run that never happened. It resolves to no account, which is
 * correct — a reader sees the identifier as written, the same as any author
 * that predates accounts having handles.
 */
export const SEND_MESSAGE_SYSTEM_AUTHOR = 'system.send-message'

/**
 * The author identifier for a message a signed-in person is sending.
 *
 * Their stored handle, never their display name. A display name in the tag
 * cannot be resolved back to an account reliably — two people can share one,
 * and renaming silently reattributes everything already written — so a name
 * there makes the avatar beside it a guess. It also collides across the two
 * kinds of thing: a display name is free text and can be set to exactly
 * somebody else's handle, so a message stamped with one could resolve to an
 * account that never sent it. That is the same forgery the graph half above
 * refuses, arriving by a different door.
 *
 * A person who has none yet is GIVEN one here rather than refused. The startup
 * pass covers everyone who existed when the process began and nobody who
 * signed up after it, so refusing would mean a new account could not speak
 * until the next restart — a rule about identifiers turning into an outage for
 * exactly the people least able to explain it.
 *
 * The refusal that remains is the one nothing can repair: an account that is
 * not there. There is deliberately no fall back to a display name, here or
 * anywhere — it is free text, so it can be set to exactly somebody else's
 * handle, and a message stamped with one would resolve to an account that
 * never sent it. That is the same forgery the graph half refuses, arriving by
 * a different door.
 */
export async function authorForPerson(userId: string): Promise<string> {
  const username = await ensureUsernameForUser(userId)
  if (!username) {
    throw new UnattributableSendError('This message has no sender: that account no longer exists.')
  }
  return username
}

interface NodeLike {
  id?: string
  type?: string
  /** Only the display name, and only to seed a handle the first time one is claimed. */
  data?: { name?: string }
}

/**
 * The author identifier for a message fed by `sourceNodeId`.
 *
 * `sourceNodeId` must come from the RUN -- the stream registry's source, or the
 * action context's input source -- and never from a graph lookup of what is
 * wired to a handle. Several things can be wired to one handle and the graph
 * cannot say which of them fired; the run can, and that difference is the whole
 * guarantee. Reading it from the run is observation, deriving it from the graph
 * is inference, and only the first is worth stamping.
 *
 * Throws when the source cannot be turned into an identity. That is the
 * unattributable case, and it is a refusal on purpose: filling it with the
 * system identifier would make that prefix mean "nobody worked out who sent
 * this", which is worth exactly as much as a tool's name.
 */
/**
 * The identifier an agent's own message is stamped with.
 *
 * The counterpart to `authorForPerson`, and deliberately the same shape: a
 * stamp is a HANDLE, never a display name. A display name is free text that two
 * accounts can share and that changes the moment somebody renames a node, so a
 * message stamped with one cannot be resolved back to an account at all — it
 * renders as the text it holds and shows no face, which is the state reserved
 * for an author nobody holds.
 *
 * The two namespaces stay disjoint on purpose. People are held in the database
 * and agents in the space graph, and the handle is the only thing they share:
 * it is what a message carries, and which of the two sources answers for it is
 * decided when the message is read, not when it is sent.
 */
export async function authorForAgentNode(agentNodeId: string, displayName: string): Promise<string> {
  const username = await ensureUsernameForAgent(agentNodeId, displayName)
  if (!username) {
    // An agent with no handle cannot be named, and naming it anything else
    // would attribute its words to something that did not say them.
    throw new UnattributableSendError(`This message has no sender: agent ${agentNodeId} has no username.`)
  }
  return username
}

export async function authorForSourceNode(sourceNodeId: string | undefined, nodes: NodeLike[]): Promise<string> {
  if (!sourceNodeId) {
    // Nothing fed this run -- fired directly, or by something that supplies no
    // source. Precisely the hole the system identifier must not fill.
    throw new UnattributableSendError('This message has no sender: nothing fed the node that sent it.')
  }
  const source = nodes.find((node) => node.id === sourceNodeId)
  if (!source?.type) {
    throw new UnattributableSendError(`This message has no sender: node ${sourceNodeId} is not in the graph.`)
  }

  if (source.type === AGENT_NODE_TYPE) {
    return authorForAgentNode(sourceNodeId, source.data?.name ?? '')
  }

  const systemAuthor = SYSTEM_AUTHOR_BY_NODE_TYPE[source.type]
  if (systemAuthor) {
    return systemAuthor
  }
  throw new UnattributableSendError(
    `This message has no sender: a "${source.type}" node is neither an agent nor a known application trigger.`,
  )
}
