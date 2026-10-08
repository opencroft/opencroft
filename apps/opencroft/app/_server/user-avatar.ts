import { createHash } from 'node:crypto'

import { parseAvatarDataUrl } from '@opencroft/auth/server'
import { db, user } from '@opencroft/db'
import { eq } from 'drizzle-orm'

/**
 * A person's avatar as something a browser can cache.
 *
 * An uploaded avatar is stored as a data URL on `user.image`. Handed to a page
 * as-is, those bytes travel inside every response that names the person and
 * can never be cached on their own. So a page gets an address instead, and the
 * picture is served from it once per version.
 *
 * SERVER-ONLY: it reads the database and hashes with node:crypto.
 */

// The query parameter carrying the version.
const VERSION_PARAM = 'v'

// A year, the longest lifetime caches honour. `private` because the picture is
// served only to a signed-in reader, so no shared cache may keep it.
const VERSIONED_CACHE = 'private, max-age=31536000, immutable'
// An address without the current version may show a different picture
// tomorrow, so it is revalidated on every use; the ETag keeps that a 304.
const UNVERSIONED_CACHE = 'private, no-cache'

/**
 * The address to draw a person's avatar from, or null when they have none.
 *
 * A stored data URL becomes `/api/avatars/<id>?v=<version>`, where the version
 * is derived from the picture itself: a new picture is a new address, so the
 * old one can be cached for good. An `http(s)` address (a social sign-in's
 * picture) is passed through, and its own host decides how it is cached.
 */
export function userAvatarUrl(account: { id: string; image?: string | null }): string | null {
  const image = account.image
  if (!image) {
    return null
  }
  if (!image.startsWith('data:')) {
    return image
  }
  return versionedAvatarAddress(`/api/avatars/${encodeURIComponent(account.id)}`, image)
}

/**
 * `path` with the version of `image` attached: the address a stored data-URL
 * picture is served from. A new picture is a new address, which is what lets
 * `avatarResponse` cache the old one for good.
 */
export function versionedAvatarAddress(path: string, image: string): string {
  return `${path}?${VERSION_PARAM}=${avatarVersion(image)}`
}

/**
 * The HTTP answer for one avatar request.
 *
 * Cached for good only when the address names the version being served. A
 * request for an older version gets the current picture revalidated instead,
 * so a superseded address never pins a picture under a version it is not.
 */
export function avatarResponse(request: Request, avatar: StoredAvatar | null): Response {
  if (!avatar) {
    return Response.json({ error: 'No avatar' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  }
  const requested = new URL(request.url).searchParams.get(VERSION_PARAM)
  const etag = `"${avatar.version}"`
  const headers = {
    'Cache-Control': requested === avatar.version ? VERSIONED_CACHE : UNVERSIONED_CACHE,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  }
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(avatar.bytes, { headers: { ...headers, 'Content-Type': avatar.contentType } })
}

// A short digest of the stored picture, which is what makes its address change with it.
function avatarVersion(image: string): string {
  return createHash('sha256').update(image).digest('hex').slice(0, 16)
}

export interface StoredAvatar {
  contentType: string
  bytes: Uint8Array<ArrayBuffer>
  version: string
}

/** The stored picture of one account, decoded, or null when there is none to serve. */
export async function readStoredAvatar(userId: string): Promise<StoredAvatar | null> {
  const [row] = await db.select({ image: user.image }).from(user).where(eq(user.id, userId)).limit(1)
  return row?.image ? decodeAvatarDataUrl(row.image) : null
}

/**
 * Decode a stored avatar; null for anything the avatar upload would not accept,
 * so a stray value is never served as an image of an arbitrary content type.
 */
export function decodeAvatarDataUrl(image: string): StoredAvatar | null {
  const parsed = parseAvatarDataUrl(image)
  if (!parsed) {
    return null
  }
  return {
    contentType: parsed.contentType,
    bytes: new Uint8Array(Buffer.from(parsed.base64, 'base64')),
    version: avatarVersion(image),
  }
}
