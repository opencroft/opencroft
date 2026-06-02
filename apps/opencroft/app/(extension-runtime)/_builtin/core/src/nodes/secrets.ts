import { React, useGraphNodes } from '@ext/host';

interface SecretsStoreNodeData {
  secretKeys?: string[];
}

/** Collect all secret key names declared by Secrets Store nodes on the graph. */
export function useSecretKeys(): string[] {
  const nodes = useGraphNodes();
  return React.useMemo(() => {
    const keys = new Set<string>();
    for (const node of nodes as { type?: string; data?: SecretsStoreNodeData }[]) {
      if (node.type !== 'core-secrets-store') {
        continue;
      }
      for (const key of node.data?.secretKeys ?? []) {
        keys.add(key);
      }
    }
    return [...keys].sort();
  }, [nodes]);
}
