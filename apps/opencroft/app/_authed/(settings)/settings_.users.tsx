import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/(settings)/settings_/users')({
  // The user list used to be a screen of its own here; it is now the `users`
  // section of the settings page. Kept as a redirect so existing links and
  // bookmarks still land on the list rather than a missing page.
  beforeLoad: () => {
    throw redirect({ to: '/settings', search: { section: 'users' } })
  },
})
