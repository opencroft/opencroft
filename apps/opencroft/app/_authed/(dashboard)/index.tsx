import { createFileRoute, redirect } from '@tanstack/react-router'

// There is no "current space" to return to: which space someone last opened is
// not the server's to remember on everyone's behalf, so the root is the list.
export const Route = createFileRoute('/_authed/(dashboard)/')({
  beforeLoad: () => {
    throw redirect({ to: '/spaces' })
  },
})
