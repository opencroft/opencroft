'use client';

import { ApprovalList } from '@/app/(approvals)/_components/approval-list';
import { FlowEditor } from '@/app/(dashboard)/_canvas/flow-editor';
import type { SpaceSummary } from '@/app/(space)/server/types';
import { SpaceSwitcher } from '@/app/(space)/space/_components/space-switcher';

interface Props {
  slug: string;
  spaces: SpaceSummary[];
}

export function SpaceCanvas({ slug, spaces }: Props) {
  const spaceName = spaces.find((s) => s.slug === slug)?.name ?? slug;
  return (
    <div className="relative h-full w-full">
      <FlowEditor slug={slug} spaceName={spaceName} />
      <div className="pointer-events-none absolute left-0 top-0 z-10 p-3">
        <div className="pointer-events-auto">
          <SpaceSwitcher slug={slug} initialSpaces={spaces} />
        </div>
      </div>
      <ApprovalList spaceId={slug} />
    </div>
  );
}
