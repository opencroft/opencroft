'use client'

import { ReactFlowProvider } from '@xyflow/react'

import { CustomTemplatesProvider } from '@/app/_authed/(legacy-app-dashboard)/_legacy/app-dashboard/custom-templates-context'
import { FlowEditor } from '@/app/_authed/(legacy-app-dashboard)/_legacy/app-dashboard/flow-editor'

export default function AppDashboardPage() {
  return (
    <div className='h-full w-full'>
      <CustomTemplatesProvider>
        <ReactFlowProvider>
          <FlowEditor />
        </ReactFlowProvider>
      </CustomTemplatesProvider>
    </div>
  )
}
