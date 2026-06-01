import { createFileRoute } from '@tanstack/react-router';

import { loadOpenclaw } from '@/app/(openclaw)/openclaw/actions';
import { OpenclawView } from '@/app/(openclaw)/openclaw/openclaw-view';

export const Route = createFileRoute('/(openclaw)/openclaw')({
  loader: () => loadOpenclaw(),
  component: OpenclawPage,
});

function OpenclawPage() {
  const state = Route.useLoaderData();
  return <OpenclawView state={state} />;
}
