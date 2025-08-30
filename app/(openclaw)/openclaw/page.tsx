import { loadOpenclaw } from '@/app/(openclaw)/openclaw/actions';
import { OpenclawView } from '@/app/(openclaw)/openclaw/openclaw-view';

export const dynamic = 'force-dynamic';

export default async function OpenclawPage() {
  const state = await loadOpenclaw();
  return <OpenclawView state={state} />;
}
