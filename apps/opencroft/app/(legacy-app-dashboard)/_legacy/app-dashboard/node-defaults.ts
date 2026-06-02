/**
 * Server-side node default data map.
 * Used by the MCP endpoint to provide sensible defaults when creating nodes,
 * without importing React client components.
 */

export const nodeDefaults: Record<string, () => Record<string, unknown>> = {
  server: () => ({ name: '', address: '', features: [] }),
  application: () => ({ appName: '', serviceNames: [] }),
  section: () => ({ label: 'Section', color: 'oklch(0.6 0.15 250)' }),
  domain: () => ({ label: 'Domain', color: 'oklch(0.6 0.15 250)' }),
  localhost: () => ({}),
  script: () => ({ name: '', code: '' }),
  wsl: () => ({ distro: '' }),
  'key-store': () => ({ keyNames: [] }),
  'secrets-store': () => ({ secretKeys: [] }),
}

/** All known built-in node type names */
export const builtinNodeTypes = Object.keys(nodeDefaults)
