import { createFileRoute, redirect } from '@tanstack/react-router'

import { getActiveSpaceSlug } from '@/app/(space)/_server/actions'

export const Route = createFileRoute('/(dashboard)/')({
  beforeLoad: async () => {
    const slug = await getActiveSpaceSlug()
    throw redirect({ to: '/space/$slug', params: { slug } })
  },
})
