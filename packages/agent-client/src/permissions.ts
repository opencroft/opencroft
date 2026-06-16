// Client-safe module: pure data/types, no node:* imports, so it can be imported
// in the browser via "agent-client/permissions".
//
// Roles grant permission to call tools and load skills. Each role carries a kv
// map keyed `tool:<slug>` / `skill:<slug>` with an access level; a key that is
// absent means the tool/skill is not permitted and must not appear in a session
// at all. Profiles assign any number of roles; a session's effective permissions
// are the union of its roles. When a session has no roles in effect, a global
// `defaultAccess` parameter governs every tool/skill instead.

export type PermissionValue = 'Allow' | 'AlwaysAllow'
export type DefaultAccess = 'Allow' | 'AlwaysAllow' | 'None'

export interface AgentRole {
  id: string // stable id
  name: string // display label
  description?: string
  // keys: "tool:<slug>" | "skill:<slug>"; absent key = not permitted.
  permissions: Record<string, PermissionValue>
}

export const toolKey = (name: string): string => `tool:${name}`
export const skillKey = (name: string): string => `skill:${name}`

// What a live session is allowed to do — consumed by both harnesses.
//  - 'scoped': only keys present in `allow` are visible (their value is the level).
//  - 'all':    every tool/skill is visible at `defaultAccess`.
//  - 'none':   nothing is visible.
export interface ResolvedPermissions {
  mode: 'scoped' | 'all' | 'none'
  allow: Record<string, PermissionValue>
  defaultAccess: PermissionValue
}

// Merge the assigned roles into a single effective permission set. With no roles
// the global default access applies to everything (None = nothing).
export function resolveSessionPermissions(roles: AgentRole[], defaultAccess: DefaultAccess): ResolvedPermissions {
  if (roles.length === 0) {
    if (defaultAccess === 'None') {
      return { mode: 'none', allow: {}, defaultAccess: 'Allow' }
    }
    return { mode: 'all', allow: {}, defaultAccess }
  }
  const allow: Record<string, PermissionValue> = {}
  for (const role of roles) {
    for (const [key, value] of Object.entries(role.permissions)) {
      // AlwaysAllow is the more permissive level and wins on conflict.
      if (allow[key] !== 'AlwaysAllow') {
        allow[key] = value
      }
    }
  }
  return { mode: 'scoped', allow, defaultAccess: 'Allow' }
}

// Decide a single key's access level. Returns null when the key is not permitted
// (the caller should hide the tool/skill entirely).
export function accessFor(perms: ResolvedPermissions | undefined, key: string): PermissionValue | null {
  // No permissions attached → unrestricted.
  if (!perms) {
    return 'Allow'
  }
  switch (perms.mode) {
    case 'none':
      return null
    case 'all':
      return perms.defaultAccess
    case 'scoped':
      return perms.allow[key] ?? null
  }
}
