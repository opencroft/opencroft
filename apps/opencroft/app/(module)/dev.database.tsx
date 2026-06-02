import IFrame from '@opencroft/ui-kit/utils/iframe'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/(module)/dev/database')({
  component: DatabasePage,
})

function DatabasePage() {
  return <IFrame title='Database' port={8081} />
}
