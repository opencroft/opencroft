import type { ComponentType } from 'react'
import type { ToolViewProps as PackageToolViewProps, ToolViewSpec } from 'agent-chat/tool-views'

import type { ToolViewProps as AppToolViewProps } from './registry'

// Type-only compile check for the migration's acceptance criteria: the fork's
// remote_edit/edit_node_property-style diff views, written against this
// app's ToolViewProps, register directly as a package tool-view-registry-v2
// ToolViewSpec with no shape changes — the package's props are a structural
// superset of the app's (they add `result.output` alongside the existing
// `result.text`/`isError`), so a component satisfying the app's narrower
// shape already satisfies the package's. Not wired into any live rendering
// path; a follow-up change does the actual migration onto the package API.
declare const anAppView: ComponentType<AppToolViewProps>

const _proof: ToolViewSpec = {
  display: 'replace',
  component: anAppView,
}
