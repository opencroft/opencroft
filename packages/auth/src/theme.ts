// The colour theme a person chooses, stored on their user record so the choice
// follows them to every browser they sign in from.
//
// Safe to import from client code: plain data, no server runtime.

/** The choices offered. `system` follows the operating system's setting. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference)
}

/**
 * The user-record field, in Better Auth's additional-field shape. The server
 * declares it (adding input and validation) and the client infers `user.theme`
 * from it, so both sides read one declaration. Null until a choice is made.
 */
export const themeUserField = {
  theme: { type: 'string', required: false },
} as const
