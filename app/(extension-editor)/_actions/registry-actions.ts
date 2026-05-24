'use server';

import {
  installExtensionFromUrl,
  type InstalledExtensionRecord,
} from '@/app/(extension-editor)/_actions/installed-extensions-actions';
import type { RegistryExtension, ResolvedRegistry } from '@/app/(extension-runtime)/_server/registry';
import { fetchAllRegistries, resolveExtensionRepo, searchRegistries } from '@/app/(extension-runtime)/_server/registry';

export async function listRegistryExtensions(query?: string): Promise<
  (RegistryExtension & { registryName: string })[]
> {
  return searchRegistries(query);
}

export async function installRegistryExtension(extensionId: string, ref?: string): Promise<InstalledExtensionRecord> {
  const resolved = await resolveExtensionRepo({ id: extensionId });
  if (!resolved) {
    throw new Error(`Extension "${extensionId}" not found in any registry`);
  }
  return installExtensionFromUrl({ url: resolved.repository, ref, auth: resolved.auth });
}

export async function getRegistries(): Promise<ResolvedRegistry[]> {
  return fetchAllRegistries();
}

export async function refreshRegistries(): Promise<ResolvedRegistry[]> {
  return fetchAllRegistries(true);
}
