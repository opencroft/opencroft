import { createFileRoute } from '@tanstack/react-router'
import { IFrame } from 'ui/utils/iframe'

import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(module)/dev/database')({
  head: () => ({ meta: [{ title: pageTitle('Database') }] }),
  component: DatabasePage,
})

function DatabasePage() {
  return <IFrame title='Database' port={8081} />
}
