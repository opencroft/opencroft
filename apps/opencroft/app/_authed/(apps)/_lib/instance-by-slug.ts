// Which instance a `/space/<space>/app/<app>` URL names.
//
// THE SLUG, AND ONLY THE SLUG. A uuid in that position is a slug-shaped string
// matching no row, so it 404s -- the same answer the address already gave for
// an app that does not exist, which is the whole of what a dead address is
// supposed to do.
//
// DO NOT "FIX" THIS BY ALSO MATCHING `entry.id`. The MCP target surface does
// accept both spellings, and it is safe there for a reason that does not carry
// over: a target's left side is `<space>.<app-slug>`, so the DOT tells the two
// forms apart structurally. A URL has no dot -- the space is its own path
// segment, so this position holds a bare app slug -- and `slugify` admits
// exactly [a-z0-9-], which is exactly the alphabet a uuid is written in. An app
// can therefore be NAMED such that its slug is a well-formed uuid, and matching
// both would mean trying one and then the other: the ambiguity the address
// grammar exists to prevent, reintroduced at the one surface people type into.
//
// Measured on the main instance when this landed: 0 of 31 app slugs were
// uuid-shaped, with a positive control. That deliberately does not settle it --
// it is a property of the two key spaces, not of the rows currently in them.

export function instanceBySlug<T extends { slug: string }>(instances: T[], slug: string): T | undefined {
  return instances.find((entry) => entry.slug === slug)
}
