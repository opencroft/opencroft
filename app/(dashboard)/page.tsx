import { redirect } from 'next/navigation';

import { getActiveSpaceSlug } from '@/app/(space)/server/actions';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const slug = await getActiveSpaceSlug();
  redirect(`/space/${slug}`);
}
