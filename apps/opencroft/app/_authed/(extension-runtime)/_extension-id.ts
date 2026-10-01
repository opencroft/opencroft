// Safe for both server and client — no runtime imports.
//
// An extension id is `<owner>.<extension>`: two slugs joined by one dot, so
// the dot is always the separator and splitting on it always parses. The same
// string names an extension everywhere: its folder under `extensions/`, its
// URLs, its storage, and the types it provides (`<owner>.<extension>.<type>`).

const SLUG = /^[a-z0-9-]+$/

/** The owner of the extensions shipped inside the app. */
export const BUILTIN_OWNER = 'builtin'

/** The owner of extensions created on, or checked out for development on, this instance. */
export const LOCAL_OWNER = 'local'

/** The extension every instance ships: the core node catalog and the Graph App. */
export const CORE_EXTENSION_ID = 'builtin.core'

/** Whether a value is a slug: lowercase letters, digits and hyphens, at least one. */
export function isSlug(value: string): boolean {
  return SLUG.test(value)
}

/** An extension id split into its two slugs, or null when it is not exactly two slugs. */
export function parseExtensionId(id: string): { owner: string; extension: string } | null {
  const parts = id.split('.')
  if (parts.length !== 2 || !parts.every(isSlug)) {
    return null
  }
  return { owner: parts[0], extension: parts[1] }
}

export function isExtensionId(id: string): boolean {
  return parseExtensionId(id) !== null
}

/** Owners no registry or repository may take: they name where an extension lives on this instance. */
export function isReservedOwner(owner: string): boolean {
  return owner === BUILTIN_OWNER || owner === LOCAL_OWNER
}

/** Whether an extension folder is a local one: editable here, and allowed to claim another extension's id. */
export function isLocalFolder(folder: string): boolean {
  return parseExtensionId(folder)?.owner === LOCAL_OWNER
}

/** The local folder for an extension created on, or checked out for development on, this instance. */
export function localFolderFor(extension: string): string {
  return `${LOCAL_OWNER}.${extension}`
}

export function isBuiltinFolder(folder: string): boolean {
  return parseExtensionId(folder)?.owner === BUILTIN_OWNER
}

/**
 * One part of an id derived from something that is not a slug — a git URL's
 * owner or repository name. Every other character, dots and underscores
 * included, becomes a hyphen. Only ever applied to one part: over a joined id
 * it would turn the separating dot into a hyphen.
 */
export function slugifyPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The URL prefix the host serves an extension under: its bundles
 * (`<base>/client.js`), and the two sub-trees named by `ExtensionUrlKind`.
 *
 * The one definition of that shape. The routes under `server/routes/api/ext/`
 * mirror it as directories, which no code can derive, so a test reads them back
 * and compares (see `bundle-routes.test.ts`). Extensions never spell it out:
 * they get it from the host as `urlBase`, `assetUrl` and `routeUrl`.
 */
export function extensionUrlBase(extensionId: string): string {
  return `/api/ext/${extensionId}`
}

/** The sub-trees an extension serves besides its bundles: static files, and its own HTTP handlers. */
export type ExtensionUrlKind = 'assets' | 'http'

/** A URL inside one of an extension's sub-trees; a leading slash on `path` is dropped. */
export function extensionUrl(extensionId: string, kind: ExtensionUrlKind, path: string): string {
  return `${extensionUrlBase(extensionId)}/${kind}/${path.replace(/^\/+/, '')}`
}

/** A type as it is stored and passed: the bare type an extension declares, qualified with its id. */
export function qualifyType(extensionId: string, bareType: string): string {
  return `${extensionId}.${bareType}`
}

/**
 * A qualified type split into the extension it names and the bare type that
 * extension declared, or null for a type that names no extension.
 *
 * A qualified node, app or handle type is `<owner>.<extension>.<type>`: three
 * slugs joined by single dots. A bare type (`localhost`) or anything else that
 * is not exactly three slugs names no extension.
 */
export function parseType(type: string): { extensionId: string; bare: string } | null {
  const parts = type.split('.')
  if (parts.length !== 3 || !parts.every(isSlug)) {
    return null
  }
  return { extensionId: `${parts[0]}.${parts[1]}`, bare: parts[2] }
}

/** The extension a qualified type names, or null for a type that names none. */
export function extensionIdOfType(type: string): string | null {
  return parseType(type)?.extensionId ?? null
}

/**
 * A type as an extension refers to it, in the form everything stores: a bare
 * type is the extension's own and is qualified with its id; a qualified one
 * names some extension, possibly another, and is kept as it is.
 */
export function resolveTypeRef(extensionId: string, ref: string): string {
  return parseType(ref) ? ref : qualifyType(extensionId, ref)
}
