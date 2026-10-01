// The browser-side auth client.
//
// Safe to import from client code — it is an HTTP client for the `/api/auth/*`
// handler and pulls in none of the server runtime. Keep it that way: importing
// ./server from here would drag the database connection into the browser bundle.

import { adminClient, inferAdditionalFields } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

import { sponsorPromptUserField } from './sponsor-prompt'
import { themeUserField } from './theme'

// No baseURL: the client talks to `/api/auth` on whatever origin the page was
// served from, which is what lets the app work across the proxy domain, the
// container name and localhost without configuration.
export const authClient = createAuthClient({
  plugins: [adminClient(), inferAdditionalFields({ user: { ...themeUserField, ...sponsorPromptUserField } })],
})

export const { useSession, signIn, signOut, updateUser } = authClient
