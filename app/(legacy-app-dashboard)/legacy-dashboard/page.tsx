'use client';

import { ReactFlowProvider } from '@xyflow/react';

import { CustomTemplatesProvider } from '@/app/(legacy-app-dashboard)/app-dashboard/custom-templates-context';
import { FlowEditor } from '@/app/(legacy-app-dashboard)/app-dashboard/flow-editor';

export default function AppDashboardPage() {
  return (
    <div className="h-full w-full">
      <CustomTemplatesProvider>
        <ReactFlowProvider>
          <FlowEditor />
        </ReactFlowProvider>
      </CustomTemplatesProvider>
    </div>
  );
}
