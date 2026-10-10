import { readEnv } from '@opencroft/instance'

// The OPENCROFT_OPENCLAW_GATEWAY_* env vars let a deployment supply the OpenClaw
// gateway's URL and token globally, for OpenClaw agents whose node leaves them
// unset. They belong to that adapter alone: every other harness sends its
// profile key to its profile's endpoint, and a gateway default reaching one of
// them would point it at the OpenClaw gateway — for Codex, sending the
// profile's key there as a Bearer token — or hand the gateway's token to a
// third-party endpoint.
export const OPENCLAW_ADAPTER_ID = 'openclaw'

export interface GatewayDefaults {
  apiKey?: string
  baseUrl?: string
}

export function gatewayDefaults(adapterId: string, env: NodeJS.ProcessEnv = process.env): GatewayDefaults {
  if (adapterId !== OPENCLAW_ADAPTER_ID) {
    return {}
  }
  const apiKey = readEnv('OPENCROFT_OPENCLAW_GATEWAY_TOKEN', env)
  const baseUrl = readEnv('OPENCROFT_OPENCLAW_GATEWAY_URL', env)
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  }
}
