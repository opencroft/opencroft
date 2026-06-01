import { createFileRoute } from '@tanstack/react-router'
import { OpenclawView } from '@/app/(openclaw)/_components/openclaw-view'
import { loadOpenclaw } from '@/app/(openclaw)/_server/actions'

export const Route = createFileRoute('/(openclaw)/openclaw')({
  loader: () => loadOpenclaw(),
  component: OpenclawPage,
})

function OpenclawPage() {
  const state = Route.useLoaderData()
  return <OpenclawView state={state} />
}
