import { createFileRoute, redirect } from '@tanstack/react-router'

// A published address of the user list, which is the `users` section of the
// administration page. Kept as a redirect so existing links and bookmarks
// still land on the list rather than a missing page.
export const Route = createFileRoute('/_authed/(settings)/settings_/users')({
  beforeLoad: () => {
    throw redirect({ to: '/administration', search: { section: 'users' } })
  },
})
