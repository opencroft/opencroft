'use client';

import Link from 'next/link';

import { ApprovalList } from '@/app/(approvals)/_components/approval-list';
import { FlowEditor } from '@/app/(dashboard)/_canvas/flow-editor';
import type { SpaceSummary } from '@/app/(space)/server/types';

interface Props {
  slug: string;
  spaces: SpaceSummary[];
}

export function SpaceCanvas({ slug, spaces }: Props) {
  const spaceName = spaces.find((s) => s.slug === slug)?.name ?? slug;
  return (
    <div className='relative h-full w-full'>
      <FlowEditor slug={slug} spaceName={spaceName} />
      <div className='pointer-events-none absolute left-0 top-0 z-10 p-3'>
        <Link
          href='/spaces'
          className='pointer-events-auto cursor-pointer text-lg font-semibold text-foreground outline-none [text-shadow:0_1px_2px_rgb(0_0_0/0.45)] hover:underline'
        >
          {spaceName}
        </Link>
      </div>
      <ApprovalList spaceId={slug} />
    </div>
  );
}
