import { ReactFlowProvider } from '@xyflow/react';
import { notFound, redirect } from 'next/navigation';

import { listSpaces, setActiveSpaceSlug } from '@/app/(space)/server/actions';
import { SpaceCanvas } from '@/app/(space)/space/_components/space-canvas';

interface Params {
  params: Promise<{ slug: string }>;
}

export default async function SpacePage({ params }: Params) {
  const { slug } = await params;
  const spaces = await listSpaces();
  if (spaces.length === 0) {
    redirect('/');
  }
  const space = spaces.find((s) => s.slug === slug);
  if (!space) {
    notFound();
  }
  await setActiveSpaceSlug(slug);
  return (
    <div className="h-full w-full">
      <ReactFlowProvider>
        <SpaceCanvas slug={slug} spaces={spaces} />
      </ReactFlowProvider>
    </div>
  );
}
