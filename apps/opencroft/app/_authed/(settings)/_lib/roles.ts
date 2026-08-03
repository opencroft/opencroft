// The display vocabulary for roles. `role` on the user row is Better Auth's
// raw value ('admin' | 'user' | null); everything in the settings UI shows
// and picks from the labels below instead, so this is the one place the two
// are translated between.

import type { Role } from '@opencroft/auth/server'

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  user: 'Member',
}

export const ROLE_OPTIONS = Object.values(ROLE_LABELS)

export function roleLabel(role: string | null): string {
  return role === 'admin' ? ROLE_LABELS.admin : ROLE_LABELS.user
}

export function roleValue(label: string): Role {
  return label === ROLE_LABELS.admin ? 'admin' : 'user'
}
