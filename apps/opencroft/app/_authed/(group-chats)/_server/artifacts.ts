import { db, groupChatThread, groupChatThreadArtifact } from '@opencroft/db'
import { and, asc, eq } from 'drizzle-orm'

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
export async function listArtifactsAsAgent(agentName: string, threadRef: string): Promise<ThreadArtifact[]> {
  const thread = await resolveThreadForAgent(await requireAgentNode(agentName), threadRef)
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
  agentName: string,
  threadRef: string,
  input: { id?: string; title: string; content: string },
): Promise<ThreadArtifact> {
  const thread = await resolveThreadForAgent(await requireAgentNode(agentName), threadRef)
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

/** Remove a note. Scoped to the resolved thread, for the same reason writes are. */
export async function deleteArtifactAsAgent(agentName: string, threadRef: string, id: string): Promise<void> {
  const thread = await resolveThreadForAgent(await requireAgentNode(agentName), threadRef)
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
