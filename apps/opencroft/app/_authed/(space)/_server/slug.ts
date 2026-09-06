export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!base) {
    return 'space'
  }
  return base
}

/**
 * An App instance's slug from its display name; 'app' when nothing survives
 * slugify. Pure on purpose: the add form previews the slug client-side with
 * this same function, so the address shown is the address minted.
 */
export function instanceSlugFor(name: string): string {
  const base = slugify(name)
  return base === 'space' ? 'app' : base
}

export function uniqueSlug(desired: string, existing: Set<string>): string {
  if (!existing.has(desired)) {
    return desired
  }
  let i = 2
  while (existing.has(`${desired}-${i}`)) {
    i += 1
  }
  return `${desired}-${i}`
}
