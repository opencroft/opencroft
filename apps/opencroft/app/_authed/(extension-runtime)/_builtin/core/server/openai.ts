import { type SecretScope, secrets } from '@opencroft/server/secrets'

import { type OpenAIChatParams, type OpenAIChatResult, requestChat } from './openai-chat'

export type { OpenAIChatParams, OpenAIChatResult }

/** `scope` is the AI Assistant node the key belongs to. */
export async function openaiChat(params: OpenAIChatParams, scope: SecretScope): Promise<OpenAIChatResult> {
  // The assistant's key as stored: typed, or `secret:NAME` resolved only here.
  const apiKey = params.apiKey?.trim() ? await secrets.resolveValue(params.apiKey, scope) : ''
  return requestChat(params, apiKey)
}
