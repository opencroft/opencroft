import { AGENT_NODE_TYPE } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { API_ROUTE_NODE_TYPE, coreType, EVENT_NODE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { agentNodesNamed } from '@/app/_authed/(space)/_server/agents-impl'
import { currentUsername, ensureUsernameForAgent, ensureUsernameForUser } from '@/app/_server/usernames'

/**
 * Who a message is from — one answer for every kind of sender.
 *
 * A GRAPH-DRIVEN message is attributed from what actually fed the run; a
 * PERSON'S message is attributed from the account that is signed in; an AGENT
 * INVOKING AN ACTION is attributed from the identity the surface it called
 * through had already established. They live together because they produce the
 * same thing: the durable identifier that goes into the delivery, never a
 * display name. A display name is not an identity — two accounts can share
 * one, and a rename silently reattributes every message already written under
 * it — so what is stamped is the handle, and what a reader sees is whatever
 * that handle resolves to now.
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
 *
 * Core's triggers are keyed by the qualified type graphs store.
 */
const SYSTEM_AUTHOR_BY_NODE_TYPE: Record<string, string> = {
  // Live, and the most exercised path here: four wirings as of 2026-08-27, one
  // of them a schedule firing every ten minutes.
  [coreType('script-node')]: 'system.script',
  // Anticipatory: no wiring feeds a send-message node through these today.
  // They are genuine triggers, so they are listed rather than left to refuse,
  // but nothing here has been exercised by a real delivery.
  [API_ROUTE_NODE_TYPE]: 'system.route',
  [EVENT_NODE_TYPE]: 'system.schedule',
  [coreType('script-bash')]: 'system.script',
  [coreType('script-python')]: 'system.script',
}

/**
 * Triggers an extension provides, keyed by the bare type it declares. The host
 * does not know which owner such an extension is installed under, so the name
 * matches from whichever extension declares it.
 */
const SYSTEM_AUTHOR_BY_EXTENSION_NODE: Record<string, string> = {
  // Live. Delivers forge notifications into the team's threads; one wiring.
  'gitea-webhook-handler': 'system.webhook',
}

function systemAuthorFor(type: string): string | undefined {
  return SYSTEM_AUTHOR_BY_NODE_TYPE[type] ?? SYSTEM_AUTHOR_BY_EXTENSION_NODE[parseType(type)?.bare ?? '']
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
 * Every system identity this application can actually stamp a message with:
 * the trigger identifiers above, plus the machinery's own voice.
 *
 * It exists because a grant must be checked against the POPULATION, not
 * against the namespace. `isSystemUsername` asks only whether a string starts
 * with `system.`, which is a shape — and a grant row for a shape nothing ever
 * sends under authorizes nothing at all while displaying in the members list
 * as granted, leaving the pipeline failing with the very message that told the
 * operator to add it. `system.scripts` is one keystroke from `system.script`
 * and is exactly that row.
 *
 * DERIVED, never restated. A hand-written copy of these strings is an
 * allow-list, and an allow-list beside the thing it lists drifts silently in
 * the same way the typo does — a trigger added above would be stampable but
 * ungrantable, which is the identical failure wearing the other hat. Adding an
 * entry to the map is the only edit either needs.
 */
export const SYSTEM_SENDER_IDS: ReadonlySet<string> = new Set([
  ...Object.values(SYSTEM_AUTHOR_BY_NODE_TYPE),
  ...Object.values(SYSTEM_AUTHOR_BY_EXTENSION_NODE),
  SEND_MESSAGE_SYSTEM_AUTHOR,
])

/**
 * The identity an extension speaks as when it sends on its own behalf —
 * through `host.groupChats` outside any agent's action call. One per
 * extension, derived from its WHOLE id, so a transcript and a members list
 * both say which extension it was: `acme.task-pipelines` speaks as
 * `system.ext.acme.task-pipelines`.
 *
 * The whole id, not its last segment: `acme.x` and `other.x` are different
 * extensions, and an identity is what a chat's grant is keyed by — sharing one
 * would hand each the other's grants. The `ext.` segment keeps these apart from
 * the trigger identities above.
 *
 * An id is already `<owner>.<extension>`, two lowercase slugs, so it is
 * appended as it is: nothing needs escaping to keep the identity a dotted path.
 */
export function extensionSystemSender(extensionId: string): string {
  return `system.ext.${extensionId}`
}

// The extensions whose host has been built in this process — each can send as
// its own identity from that moment, so each is part of the population a grant
// is checked against. Derived from the running extensions, never listed by
// hand, for the reason SYSTEM_SENDER_IDS gives. globalThis-backed because dev
// SSR can re-instantiate this module while the hosts it would forget live on.
const globalForExtensionSenders = globalThis as unknown as { __EXTENSION_SYSTEM_SENDERS__?: Set<string> }
if (!globalForExtensionSenders.__EXTENSION_SYSTEM_SENDERS__) {
  globalForExtensionSenders.__EXTENSION_SYSTEM_SENDERS__ = new Set()
}
const extensionSystemSenders = globalForExtensionSenders.__EXTENSION_SYSTEM_SENDERS__

/** Record that an extension's host exists, and return the identity it sends as. */
export function registerExtensionSystemSender(extensionId: string): string {
  const id = extensionSystemSender(extensionId)
  extensionSystemSenders.add(id)
  return id
}

/** Whether `value` names a system sender that exists — see SYSTEM_SENDER_IDS and extensionSystemSender. */
export function isKnownSystemSender(value: string): boolean {
  return SYSTEM_SENDER_IDS.has(value) || extensionSystemSenders.has(value)
}

/** Every system sender a grant may name right now, sorted. */
export function listSystemSenderIds(): string[] {
  return [...new Set([...SYSTEM_SENDER_IDS, ...extensionSystemSenders])].sort()
}

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
 *
 * It CLAIMS a handle when the agent has none, which is why it takes a display
 * name to seed one from. That is only correct where the caller has named the
 * agent it is sending as — the direct-send path does, a node fed into a run
 * does not. `authorForSourceNode` therefore refuses instead of calling this.
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

/** What an entry of `listAgentNodesImpl`'s listing carries that matters here. */
interface AgentNodeLike {
  nodeId?: string
  name?: string
}

/**
 * The author identifier for a message an agent sends by invoking a node's
 * action itself, rather than by feeding that node from the graph.
 *
 * THE THIRD DOOR, AND WHY IT IS NOT THE FIRST ONE WIDENED. `senderForSourceNode`
 * asks what fed this run, and refuses when nothing did. A direct invocation is
 * exactly that case -- and it is not the unattributable one. Nothing fed the
 * node because somebody the platform had already authenticated invoked it, and
 * the identity was sitting one frame up the call the whole time. So the
 * refusal is not relaxed: a run with neither a source node nor a caller still
 * reaches it, in the same words. What changes is that a run WITH a caller
 * stops being counted among them.
 *
 * THE NAME IS ASSERTED BY THE SURFACE, never taken from a tool argument. It
 * comes from the request's credential or from the calling session's own
 * bookkeeping -- see `ToolCallerContext` -- so what arrives here is already an
 * answer to "who is asking", and turning it into the durable handle a delivery
 * carries is all that is left to do.
 *
 * `agents` is every agent node, not one space's graph. Who invoked an action
 * is not a fact about wiring, and scoping the lookup to whichever space the
 * node happens to sit in would refuse an agent for standing somewhere else.
 *
 * A NAME MATCHING NONE OR SEVERAL IS A REFUSAL, and the same one. A display
 * name is free text that two agent nodes can share, so picking either would
 * deliver a message as an agent that did not send it -- the forgery this
 * module exists to prevent, arriving by a third door. To a sender who cannot
 * be named, unknown and ambiguous are the same fact.
 *
 * That is this path's policy, not the comparison's. `agentNodesNamed` owns how
 * a name is matched and says nothing about what to do with the answer: a
 * membership lookup takes the first match, because agent names are a
 * decided-unique namespace, and an attribution cannot -- being told a
 * namespace is unique is not the same as a message being safe to stamp when it
 * is not.
 */
async function senderForCallingAgent(agentName: string, agents: AgentNodeLike[]): Promise<AttributedSender> {
  const matches = agentNodesNamed(agents, agentName)
  const match = matches.length === 1 ? matches[0] : undefined
  if (!match?.nodeId) {
    throw new UnattributableSendError(`This message has no sender: no single agent is named "${agentName.trim()}".`)
  }
  return {
    author: await authorForAgentNode(match.nodeId, match.name ?? agentName.trim()),
    principal: { kind: 'agent', agentNodeId: match.nodeId },
  }
}

/**
 * The principal a membership gate checks a send against — WHICH agent node, or
 * WHICH system identity, not just what the transcript will display. A person
 * never appears here: people send through request-authenticated surfaces, and
 * the node/tool paths this accompanies are exactly the ones with no request to
 * authenticate.
 */
export type SendPrincipal = { kind: 'agent'; agentNodeId: string } | { kind: 'system'; systemId: string }

/**
 * Both halves of who a send is from: the username the transcript stamps, and
 * the principal an authorization gate checks. One value, derived together, so
 * the identity that is DISPLAYED and the identity that is AUTHORIZED cannot be
 * computed by two code paths that drift apart.
 */
export interface AttributedSender {
  author: string
  principal: SendPrincipal
}

export async function senderForSourceNode(
  sourceNodeId: string | undefined,
  nodes: NodeLike[],
): Promise<AttributedSender> {
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
    // Deliberately NOT `authorForAgentNode`. That claims a handle when there is
    // none, which is right where a caller has named the agent it is sending as,
    // and wrong here: a node fed into a run may carry no name at all, and
    // minting an identifier from nothing would put this agent's words under one
    // nobody chose. On this path the refusal IS the design.
    const username = await currentUsername({ kind: 'agent', id: sourceNodeId })
    if (!username) {
      // An agent with no handle cannot be named, and naming it anything else
      // would attribute its words to something that did not say them.
      throw new UnattributableSendError(`This message has no sender: agent ${sourceNodeId} has no username.`)
    }
    return { author: username, principal: { kind: 'agent', agentNodeId: sourceNodeId } }
  }

  const systemAuthor = systemAuthorFor(source.type)
  if (systemAuthor) {
    // The system identity is BOTH halves on purpose: what the transcript shows
    // is exactly what a membership grant authorizes, so machine origin — and
    // which machine — stays readable in the record and in the members list.
    return { author: systemAuthor, principal: { kind: 'system', systemId: systemAuthor } }
  }
  throw new UnattributableSendError(
    `This message has no sender: a "${source.type}" node is neither an agent nor a known application trigger.`,
  )
}

/**
 * Which of the two questions answers for this send, and in which order.
 *
 * There are two facts a send can carry and they are not the same one.
 * `sourceNodeId` says what PRODUCED this text; `callerAgent` says who ASKED
 * for it to go. A graph-fed run has the first and never the second; an action
 * somebody invoked has the second and never the first; and a run with neither
 * is the case the refusal was written for and still reaches it, from the same
 * call, in the same words.
 *
 * THE SOURCE NODE DECIDES WHEREVER IT EXISTS, so no path that works today is
 * re-decided by this. It is also the right order on its own terms: where both
 * were somehow present, the text would have an origin of its own, and
 * preferring the caller would attribute a forwarded message to whoever
 * forwarded it.
 *
 * `agents` IS A THUNK, and that is not a style choice. Listing agent nodes
 * walks every space in the registry, and the graph path -- the one every
 * webhook and every schedule takes -- has no use for the answer. Taking the
 * list would make each of those sends pay for a lookup none of them reads.
 */
export async function senderForSend(
  origin: { sourceNodeId?: string; callerAgent?: string },
  nodes: NodeLike[],
  agents: () => Promise<AgentNodeLike[]>,
): Promise<AttributedSender> {
  if (!origin.sourceNodeId && origin.callerAgent) {
    return senderForCallingAgent(origin.callerAgent, await agents())
  }
  return senderForSourceNode(origin.sourceNodeId, nodes)
}
