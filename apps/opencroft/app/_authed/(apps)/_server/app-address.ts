// THE ONE PLACE an app reference becomes a row. Two spellings, one definition:
//
//   <space>.<app-slug>   the ADDRESS  -- public, readable, minted from the name
//   <uuid>               the IDENTITY -- internal, never reused, never reissued
//
// The DOT decides which, structurally, so there is no try-one-then-the-other
// order to get wrong. `slugify` collapses everything outside [a-z0-9] to '-',
// and both space slugs and instance slugs mint through it, so a slug cannot
// contain a dot and an address always does.
//
// FOR WHOEVER WIDENS THIS LATER: in a terminal target the left position holds
// THREE forms, not two -- the literal `extensions` sentinel (`extensions/<slug>`,
// resolved before anything reaches here), a graph node id, and an app
// reference. The two non-address forms are dotless, so "a dotless left side is
// a uuid" is NOT true of that position and the sentinel check upstream is not
// redundant. The dot selects the address branch and nothing else.
//
// Nothing downstream of this function learns the address grammar: it hands back
// a row, and every caller carries on with the uuid it already used.

import { db, spaceApp } from '@opencroft/db'
import { and, eq } from 'drizzle-orm'

import { registry } from '@/app/_authed/(space)/_server/actions-impl'

type SpaceAppRow = typeof spaceApp.$inferSelect

/**
 * True for the dotted, public form. Pure string work on the caller's own
 * argument, so a caller can decide which failure it owes before any lookup.
 */
export function isAppAddress(ref: string): boolean {
  return ref.includes('.')
}

/**
 * The row one app reference names, or null.
 *
 * ONE INDEX TRAVERSAL EITHER WAY, which is the constraint this change was
 * given. The identity form is a primary-key read. The address form resolves
 * the space half through the in-process registry -- a Map over state the
 * server already holds, not a second round trip -- and then reads
 * `SpaceApp_spaceId_slug_key`, a unique index that already exists on exactly
 * the pair the address names. The space half goes through `getBySlug` for the
 * same reason every other space-addressed surface does: it follows the alias a
 * space rename leaves behind, so a renamed space still resolves.
 */
export async function resolveAppAddress(ref: string): Promise<SpaceAppRow | null> {
  const dot = ref.indexOf('.')
  if (dot === -1) {
    return (await db.query.spaceApp.findFirst({ where: eq(spaceApp.id, ref) })) ?? null
  }
  // Split at the FIRST dot, the same convention `parseGraphAddress` uses. What
  // follows it is the whole instance slug, so a second dot cannot be part of
  // one -- answered here rather than left to a query that could never match.
  const spaceSlug = ref.slice(0, dot)
  const appSlug = ref.slice(dot + 1)
  if (appSlug.includes('.')) {
    return null
  }
  const space = (await registry()).getBySlug(spaceSlug)
  if (!space) {
    return null
  }
  return (
    (await db.query.spaceApp.findFirst({
      where: and(eq(spaceApp.spaceId, space.id), eq(spaceApp.slug, appSlug)),
    })) ?? null
  )
}

/**
 * The public address of a row — the inverse of `resolveAppAddress`, and the one
 * place a row becomes `<space>.<slug>`. Undefined when the owning space is not
 * in the registry, which is a broken invariant rather than a normal outcome:
 * callers say nothing rather than composing an address around a blank.
 */
export async function appAddressOf(row: SpaceAppRow): Promise<string | undefined> {
  const space = (await registry()).getById(row.spaceId)
  return space ? `${space.slug}.${row.slug}` : undefined
}

/**
 * Why one app target did not resolve, said precisely enough to act on.
 *
 * THE DISTINCTION IS THE POINT. A target whose app resolves but whose HANDLE
 * does not used to be reported as a missing node, which sends the reader
 * looking for the wrong thing entirely -- the node was found; the handle was
 * the miss. Each branch also names the address grammar and the tool that lists
 * real ones, because an unresolvable target is the only moment a caller
 * holding the old spelling is reading anything at all.
 *
 * Costs one read, on a path that has already failed.
 */
export async function unresolvedAppTarget(ref: string, handleId: string): Promise<string> {
  const app = await resolveAppAddress(ref)
  if (app) {
    return `"${ref}" is an app, but it exposes no handle "${handleId}".`
  }
  if (isAppAddress(ref)) {
    return `No app answers to "${ref}". An app is addressed <space>.<app-slug> — run app_list to see them.`
  }
  return `Nothing answers to "${ref}": no graph node, and no app. An app is addressed <space>.<app-slug> — run app_list to see them.`
}
