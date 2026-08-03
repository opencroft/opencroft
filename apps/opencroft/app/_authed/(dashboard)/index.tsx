import { createFileRoute, redirect } from '@tanstack/react-router'

import { getActiveSpaceSlug } from '@/app/_authed/(space)/_server/actions'

export const Route = createFileRoute('/_authed/(dashboard)/')({
  beforeLoad: async () => {
    const slug = await getActiveSpaceSlug()
    throw redirect({ to: '/space/$slug', params: { slug } })
  },
})
