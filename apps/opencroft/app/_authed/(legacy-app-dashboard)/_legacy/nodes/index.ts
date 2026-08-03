import type { NodeTypeDefinition } from '@/app/_authed/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { applicationDefinition } from '@/app/_authed/(legacy-app-dashboard)/_legacy/nodes/application'
import { keyStoreDefinition } from '@/app/_authed/(legacy-app-dashboard)/_legacy/nodes/key-store'
import { localhostDefinition } from '@/app/_authed/(legacy-app-dashboard)/_legacy/nodes/localhost'
import { scriptDefinition } from '@/app/_authed/(legacy-app-dashboard)/_legacy/nodes/script'
import { secretsStoreDefinition } from '@/app/_authed/(legacy-app-dashboard)/_legacy/nodes/secrets-store'
import { domainDefinition, sectionDefinition } from '@/app/_authed/(legacy-app-dashboard)/_legacy/nodes/section'
import { serverDefinition } from '@/app/_authed/(legacy-app-dashboard)/_legacy/nodes/server'
import { wslDefinition } from '@/app/_authed/(legacy-app-dashboard)/_legacy/nodes/wsl'

export const nodeDefinitions: readonly NodeTypeDefinition[] = [
  secretsStoreDefinition,
  keyStoreDefinition,
  applicationDefinition,
  localhostDefinition,
  serverDefinition,
  wslDefinition,
  scriptDefinition,
  sectionDefinition,
  domainDefinition,
]
