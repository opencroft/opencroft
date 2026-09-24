import { db, groupChatThread, groupChatThreadArtifact } from '@opencroft/db'
import { and, asc, eq } from 'drizzle-orm'

import type { AgentRef } from '@/app/_authed/(space)/_server/agents-impl'
import { GroupChatAccessError, requireAgentNode, requireGroupChatMember, resolveThreadForAgent } from './model'

/**
 * Artifacts: the notes an agent leaves on a thread after doing work, and
 * revises on a later iteration.
 *
 * The agent-facing half is here. Every function takes the CALLING agent and an
 * opaque thread reference, and resolves both through resolveThreadForAgent —
 * so an agent reaches exactly the threads in chats a person put it in, and an
 * unresolvable reference is indistinguishable from a thread in someone else's
 * chat. There is no parameter for acting as another agent, which is what keeps
 * the membership gate meaningful.
 *
 * Each takes the agent NAME, which is what the tool surface asserts, and turns
 * it into a node id before anything is checked: membership is recorded against
 * the node, so passing the name through would compare a name to an id and
 * refuse every call as though the thread did not exist.
 *
 * These are deliberately NOT request-gated like pins are. A pin is written by a
 * person through a screen; an artifact is written by an agent mid-turn, with no
 * HTTP request in sight. The reading half for the UI is request-gated, below.
 */

const UNAVAILABLE = 'That thread is not available.'

export interface ThreadArtifact {
  id: string
  title: string
  content: string
  createdAt: Date
  updatedAt: Date
}

const artifactColumns = {
  id: groupChatThreadArtifact.id,
  title: groupChatThreadArtifact.title,
  content: groupChatThreadArtifact.content,
  createdAt: groupChatThreadArtifact.createdAt,
  updatedAt: groupChatThreadArtifact.updatedAt,
}

// Oldest first: artifacts accumulate as work proceeds, so creation order is the
// order they were reasoned in. Sorting by updatedAt would reshuffle the strip
// every time one was revised, which is exactly when the reader is looking for
// the one they already knew the position of.
function listForThread(threadId: string): Promise<ThreadArtifact[]> {
  return db
    .select(artifactColumns)
    .from(groupChatThreadArtifact)
    .where(eq(groupChatThreadArtifact.threadId, threadId))
    .orderBy(asc(groupChatThreadArtifact.createdAt))
}

/** The thread's artifacts, for the calling agent. */
export async function listArtifactsAsAgent(agent: AgentRef, threadRef: string): Promise<ThreadArtifact[]> {
  const thread = await resolveThreadForAgent(await requireAgentNode(agent), threadRef)
  return listForThread(thread.id)
}

/**
 * Create a note, or revise one that exists.
 *
 * One entry point rather than separate create and update tools: an agent
 * revising its own note on a later iteration is doing the same act on the same
 * thing, and two tools would make it decide which — a decision it can get wrong
 * by writing a duplicate instead of updating.
 *
 * `id` absent creates. `id` present updates, and only if that artifact belongs
 * to the resolved thread: an id from another thread is refused rather than
 * moved, so a reference cannot be used to write into a chat the agent is not in.
 */
export async function writeArtifactAsAgent(
  agent: AgentRef,
  threadRef: string,
  input: { id?: string; title: string; content: string },
): Promise<ThreadArtifact> {
  const thread = await resolveThreadForAgent(await requireAgentNode(agent), threadRef)
  const title = input.title.trim()
  const content = input.content.trim()
  if (!title) {
    throw new Error('An artifact needs a title')
  }
  if (!content) {
    throw new Error('An artifact needs some content')
  }

  if (input.id) {
    // Scoped to the thread, not just the id -- see this function's own note.
    const [existing] = await db
      .select({ id: groupChatThreadArtifact.id })
      .from(groupChatThreadArtifact)
      .where(and(eq(groupChatThreadArtifact.id, input.id), eq(groupChatThreadArtifact.threadId, thread.id)))
      .limit(1)
    if (!existing) {
      throw new GroupChatAccessError('not-found', 'That artifact is not available.')
    }
    const [updated] = await db
      .update(groupChatThreadArtifact)
      .set({ title, content })
      .where(eq(groupChatThreadArtifact.id, input.id))
      .returning(artifactColumns)
    return updated
  }

  const [created] = await db
    .insert(groupChatThreadArtifact)
    .values({ threadId: thread.id, title, content })
    .returning(artifactColumns)
  return created
}

/**
 * The replacement rule itself, kept separate from the row it will be written to
 * so it can be exercised without a database. Everything interesting about this
 * operation is here: what counts as a match, and when a caller is told no.
 *
 * Throws rather than returning a result union because every caller is a tool
 * handler whose job is to turn a thrown message into a refusal the agent reads.
 */
export function applyExactReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  const occurrences = content.split(oldString).length - 1
  if (occurrences === 0) {
    throw new Error('oldString was not found in the artifact')
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `oldString appears ${occurrences} times — pass replaceAll, or extend it with surrounding text until it is unique`,
    )
  }
  // split/join for replaceAll rather than a RegExp: the fragment is arbitrary
  // markdown, and building a pattern from it would give characters like * and (
  // a meaning the caller never asked for.
  return replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

/**
 * Replace an exact fragment of a note, leaving the rest untouched.
 *
 * The reason this exists beside `writeArtifactAsAgent`: revising one paragraph
 * of a long note by rewriting the whole thing costs the entire document twice —
 * once to read it back, once to send it — and every one of those round trips is
 * a chance to drop a section nobody noticed was missing. An exact replacement
 * touches what it names and can lose nothing else.
 *
 * REFUSES ON AN AMBIGUOUS MATCH, and that is the point of the operation rather
 * than a safety rail bolted on. A fragment appearing twice means the caller does
 * not know which one it is editing, so acting on the first would be a guess made
 * silently. `replaceAll` is how a caller says it meant every occurrence.
 */
export async function editArtifactAsAgent(
  agent: AgentRef,
  threadRef: string,
  input: { id: string; oldString: string; newString: string; replaceAll?: boolean },
): Promise<ThreadArtifact> {
  const thread = await resolveThreadForAgent(await requireAgentNode(agent), threadRef)
  if (!input.oldString) {
    throw new Error('oldString cannot be empty — use artifact_write to replace a note wholesale')
  }
  const [existing] = await db
    .select({ id: groupChatThreadArtifact.id, content: groupChatThreadArtifact.content })
    .from(groupChatThreadArtifact)
    .where(and(eq(groupChatThreadArtifact.id, input.id), eq(groupChatThreadArtifact.threadId, thread.id)))
    .limit(1)
  if (!existing) {
    throw new GroupChatAccessError('not-found', 'That artifact is not available.')
  }

  const content = applyExactReplacement(existing.content, input.oldString, input.newString, input.replaceAll === true)
  if (!content.trim()) {
    throw new Error('That edit would leave the artifact empty — delete it instead if it should not exist')
  }

  const [updated] = await db
    .update(groupChatThreadArtifact)
    .set({ content })
    .where(eq(groupChatThreadArtifact.id, input.id))
    .returning(artifactColumns)
  return updated
}

/** Remove a note. Scoped to the resolved thread, for the same reason writes are. */
export async function deleteArtifactAsAgent(agent: AgentRef, threadRef: string, id: string): Promise<void> {
  const thread = await resolveThreadForAgent(await requireAgentNode(agent), threadRef)
  const deleted = await db
    .delete(groupChatThreadArtifact)
    .where(and(eq(groupChatThreadArtifact.id, id), eq(groupChatThreadArtifact.threadId, thread.id)))
    .returning({ id: groupChatThreadArtifact.id })
  if (deleted.length === 0) {
    throw new GroupChatAccessError('not-found', 'That artifact is not available.')
  }
}

/**
 * The reading half for the UI: a person's own membership decides what they can
 * see, exactly as it does for the thread's messages. Separate from the agent
 * path above because the two authenticate completely differently — a request
 * with a session versus an agent identity asserted from its own session — and a
 * single function taking either would be one `if` away from letting a caller
 * choose which check to face.
 */
export async function listArtifactsForThread(request: Request, threadId: string): Promise<ThreadArtifact[]> {
  const [thread] = await db
    .select({ groupChatId: groupChatThread.groupChatId })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  if (!thread) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  await requireGroupChatMember(request, thread.groupChatId)
  return listForThread(threadId)
}
