import { createFileRoute } from '@tanstack/react-router'

import IFrame from '@opencroft/ui-kit/utils/iframe'

export const Route = createFileRoute('/(module)/dev/database')({
  component: DatabasePage,
})

function DatabasePage() {
  return <IFrame title='Database' port={8081} />
}
