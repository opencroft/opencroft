'use server';

import { ensureExtensionBuilt, getExtensionModule, loadAllManifests } from '@/app/(extension-runtime)/_server/loader';
import { type ExtensionManifest } from '@/app/(extension-runtime)/_types';

export async function invokeExtensionAction(
  extensionId: string,
  actionName: string,
  args: unknown[],
): Promise<unknown> {
  const mod = await getExtensionModule(extensionId);
  const fn = mod.actions[actionName];
  if (!fn) {
    throw new Error(`Extension ${extensionId} has no action "${actionName}"`);
  }
  return fn(...args);
}

export async function listExtensionManifests(): Promise<ExtensionManifest[]> {
  return loadAllManifests();
}

export async function rebuildExtension(extensionId: string): Promise<void> {
  await ensureExtensionBuilt(extensionId);
}
