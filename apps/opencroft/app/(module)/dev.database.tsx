import IFrame from 'ui/utils/iframe'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/(module)/dev/database')({
  component: DatabasePage,
})

function DatabasePage() {
  return <IFrame title='Database' port={8081} />
}
