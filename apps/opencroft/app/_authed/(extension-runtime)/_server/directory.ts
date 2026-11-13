import { db, spaceApp } from '@opencroft/db'
import type { HostAppDirectoryEntry, HostSpace } from '@opencroft/server'
import { asc } from 'drizzle-orm'

import { type DirectoryChange, subscribeDirectoryChanges } from '@/app/_authed/(space)/_server/directory-changes'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

/**
 * Whom a directory answers for, as the host established it: a caller it bound
 * (a signed-in person, an agent), or an extension's own system identity.
 */
export type DirectoryViewer =
  | { kind: 'person'; userId: string }
  | { kind: 'agent'; name: string }
  | { kind: 'system'; systemId: string }

// Lazy: the group-chat model reaches the extension host through its own
// imports, and this module is imported by the host.
const groupChatModel = () => import('@/app/_authed/(group-chats)/_server/model')
const hostApps = () => import('@/app/_authed/(apps)/_server/host-apps')

/**
 * The slugs of the spaces `viewer` may see, or `null` for every space.
 *
 * Spaces carry no membership of their own: every signed-in person and every
 * agent is in every space, which is what the app's spaces list and the
 * agents' `list_spaces` show them (see `slugAddressesASpace` in the
 * group-chat model). When space-level restrictions arrive, the person and
 * agent branches are where they go.
 *
 * A system identity is in no space until a grant lets it in: a member row in
 * the space's chat (see `spacesGrantingSystemSender`).
 */
async function visibleSpaceSlugs(viewer: DirectoryViewer): Promise<Set<string> | null> {
  if (viewer.kind !== 'system') {
    return null
  }
  return (await groupChatModel()).spacesGrantingSystemSender(viewer.systemId)
}

async function registry() {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  return r
}

/** Which listing a subscriber re-reads: `spaces.list` or `apps.directory`. */
export type DirectoryListing = 'spaces' | 'apps'

// What each listing's answer is made of. An app's address rides on its
// space's slug and an app goes with its space, so every space change reaches
// the apps listing too; what a viewer may see moves both.
const SUBJECTS_OF: Record<DirectoryListing, ReadonlySet<DirectoryChange['subject']>> = {
  spaces: new Set(['space', 'access']),
  apps: new Set(['space', 'app', 'access']),
}

/** Hear the changes that can change `listing`'s answer. Returns the unsubscribe. */
export function subscribeDirectoryListing(
  listing: DirectoryListing,
  listener: (change: DirectoryChange) => void | Promise<void>,
): () => void {
  const subjects = SUBJECTS_OF[listing]
  return subscribeDirectoryChanges((change) => (subjects.has(change.subject) ? listener({ ...change }) : undefined))
}

/** The spaces `viewer` may see, by name. */
export async function listSpacesFor(viewer: DirectoryViewer): Promise<HostSpace[]> {
  const [r, visible] = await Promise.all([registry(), visibleSpaceSlugs(viewer)])
  return r
    .list()
    .filter((space) => visible === null || visible.has(space.slug))
    .map((space) => ({ slug: space.slug, name: space.name, icon: space.icon }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every App instance in a space `viewer` may see, oldest first; with
 * `options.space`, that one space's (a slug a rename freed still names it).
 * Read from the stored rows and the manifests, so no App is asked anything.
 */
export async function appDirectoryFor(
  viewer: DirectoryViewer,
  options: { space?: string } = {},
): Promise<HostAppDirectoryEntry[]> {
  const [r, visible, provided] = await Promise.all([
    registry(),
    visibleSpaceSlugs(viewer),
    hostApps().then((m) => m.providedApps()),
  ])
  const wanted = options.space === undefined ? undefined : r.getBySlug(options.space)?.slug
  if (options.space !== undefined && !wanted) {
    return []
  }
  const slugById = new Map(r.list().map((space) => [space.id, space.slug]))
  const entryByType = new Map(provided.map((p) => [p.value.type, p.value]))
  const rows = await db.query.spaceApp.findMany({ orderBy: asc(spaceApp.createdAt) })
  return rows.flatMap((row): HostAppDirectoryEntry[] => {
    const spaceSlug = slugById.get(row.spaceId)
    if (!spaceSlug || (wanted && spaceSlug !== wanted) || (visible && !visible.has(spaceSlug))) {
      return []
    }
    const entry = entryByType.get(row.type)
    return [
      {
        address: `${spaceSlug}.${row.slug}`,
        instanceId: row.id,
        type: row.type,
        name: row.name,
        slug: row.slug,
        spaceSlug,
        ...(entry?.icon ? { icon: entry.icon } : {}),
        ...(entry?.accent ? { accent: entry.accent } : {}),
      },
    ]
  })
}
