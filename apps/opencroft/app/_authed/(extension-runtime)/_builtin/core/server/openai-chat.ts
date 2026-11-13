// A chat request to an OpenAI-compatible endpoint. A failure is thrown as the
// problem the node records and an agent's `call` answers (`NodeActionHandler`):
// what failed, the endpoint's own words, and which AI Assistant setting to look
// at. Host-free, so tests load it directly; `openai.ts` resolves the key.

import type { NodeError } from '@opencroft/core'

export interface OpenAIChatParams {
  apiBase: string
  /** Typed, or `secret:NAME`. */
  apiKey: string
  model: string
  systemPrompt: string
  userPrompt: string
  temperature: number
}

export interface OpenAIChatResult {
  content: string
  model: string
  promptTokens: number
  completionTokens: number
}

interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

interface OpenAIChoice {
  message: { content: string }
}

interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
}

interface OpenAIResponse {
  model: string
  choices: OpenAIChoice[]
  usage: OpenAIUsage
  error?: { message: string }
}

/** An error carrying `problem`, with the problem's title and detail as its message. */
export function problemError(problem: NodeError): Error {
  const message = problem.detail ? `${problem.title}: ${problem.detail}` : problem.title
  return Object.assign(new Error(message), { problem })
}

/** The endpoint as a reader may see it: no credentials, no query. */
function endpointText(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}

// fetch rejects with "fetch failed" and keeps the reason (refused, unknown
// host, timeout) in its cause. A reason can quote the whole URL, credentials
// included, so the URL is replaced with what a reader may see.
function reasonOf(err: unknown, url: string): string {
  const reason = err instanceof Error && err.cause !== undefined ? err.cause : err
  const text = reason instanceof Error ? reason.message : String(reason)
  return text.replaceAll(url, endpointText(url))
}

function refusedNext(status: number): string {
  if (status === 401 || status === 403) {
    return "Check the AI Assistant's API Key."
  }
  if (status === 404) {
    return "Check the AI Assistant's Model and API Base."
  }
  if (status === 429) {
    return 'Run again later, or check the limits of the account behind the API Key.'
  }
  return "Read the detail, then fix the AI Assistant's settings or run again."
}

function buildMessages(system: string, user: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (system.trim()) {
    messages.push({ role: 'system', content: system })
  }
  messages.push({ role: 'user', content: user })
  return messages
}

/** The chat request, with `apiKey` already resolved from what the assistant stores. */
export async function requestChat(params: OpenAIChatParams, apiKey: string): Promise<OpenAIChatResult> {
  const base = (params.apiBase || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const url = `${base}/chat/completions`
  const body = {
    model: params.model,
    messages: buildMessages(params.systemPrompt, params.userPrompt),
    temperature: params.temperature,
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (err) {
    throw problemError({
      title: "Can't reach the model endpoint",
      detail: `${endpointText(url)}: ${reasonOf(err, url)}`,
      next: "Check the AI Assistant's API Base and that the server behind it is running.",
    })
  }
  let data: OpenAIResponse
  try {
    data = (await res.json()) as OpenAIResponse
  } catch {
    throw problemError({
      title: 'The model endpoint did not answer as an OpenAI API',
      detail: `${endpointText(url)} answered HTTP ${res.status} with no JSON reply.`,
      next: "Check that the AI Assistant's API Base is the API's root, such as https://api.openai.com/v1.",
    })
  }
  if (!res.ok || data.error) {
    const message = data.error?.message?.trim()
    throw problemError({
      title: 'The model endpoint refused the request',
      ...(message ? { detail: message } : {}),
      code: `HTTP ${res.status}`,
      next: refusedNext(res.status),
    })
  }
  return {
    content: data.choices[0]?.message?.content ?? '',
    model: data.model,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  }
}
