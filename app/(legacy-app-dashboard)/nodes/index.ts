import { type NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/app-dashboard/registry';
import { applicationDefinition } from '@/app/(legacy-app-dashboard)/nodes/application';
import { keyStoreDefinition } from '@/app/(legacy-app-dashboard)/nodes/key-store';
import { localhostDefinition } from '@/app/(legacy-app-dashboard)/nodes/localhost';
import { scriptDefinition } from '@/app/(legacy-app-dashboard)/nodes/script';
import { secretsStoreDefinition } from '@/app/(legacy-app-dashboard)/nodes/secrets-store';
import { domainDefinition, sectionDefinition } from '@/app/(legacy-app-dashboard)/nodes/section';
import { serverDefinition } from '@/app/(legacy-app-dashboard)/nodes/server';
import { wslDefinition } from '@/app/(legacy-app-dashboard)/nodes/wsl';

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
];
