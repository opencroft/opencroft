'use server';

import type { RegistryExtension, ResolvedRegistry } from '@/app/(extension-runtime)/_server/registry';
import { fetchAllRegistries, searchRegistries } from '@/app/(extension-runtime)/_server/registry';

export async function listRegistryExtensions(query?: string): Promise<
  (RegistryExtension & { registryName: string })[]
> {
  return searchRegistries(query);
}

export async function getRegistries(): Promise<ResolvedRegistry[]> {
  return fetchAllRegistries();
}

export async function refreshRegistries(): Promise<ResolvedRegistry[]> {
  return fetchAllRegistries(true);
}
