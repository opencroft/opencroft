'use client';

import { FlowEditor } from '@/app/(dashboard)/_canvas/flow-editor';
import type { SpaceSummary } from '@/app/(space)/server/types';

interface Props {
  slug: string;
  spaces: SpaceSummary[];
}

export function SpaceCanvas({ slug, spaces }: Props) {
  const spaceName = spaces.find((s) => s.slug === slug)?.name ?? slug;
  return (
    <FlowEditor slug={slug} spaceName={spaceName} />
  );
}
