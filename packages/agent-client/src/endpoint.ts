// How a selection becomes an endpoint and a model.
//
// Two callers resolve the same AgentSelection against the same endpoints: the
// in-process agent loop (native-harness) and the independent completions
// (chat-completion). The resolution lives here once rather than being restated
// per caller — two definitions of "which URL does this profile talk to" drift
// the moment one gains a fallback the other lacks.

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'

import { mergeHeaders } from './endpoint-headers'
import { discoverModels, type OpenAiModel } from './models'
import { leastEffort } from './reasoning'
import { findProvider, nativeApi } from './resolve'
import type { AgentSelection, NativeApi } from './types'

// The API a selection's calls go through (resolve.ts `nativeApi`). A selection
// with a Base URL and no API named, a provider the table does not know
// included, is reached at that URL over Chat Completions, the one API any
// OpenAI-compatible URL is assumed to serve.
export function selectionApi(selection: AgentSelection): NativeApi {
  const api = nativeApi(selection)
  if (!api) {
    throw new Error(
      `Provider "${selection.providerId}" has no endpoint the native harness speaks: it reaches models over Chat Completions, Responses or Anthropic Messages.`,
    )
  }
  return api
}

// The base URL for the selection's API. A per-selection baseUrl override wins,
// read as that API's base; otherwise the provider table's endpoint for it;
// otherwise the vendor's public default. An Anthropic base is the one Claude
// Code takes as ANTHROPIC_BASE_URL, the same value the provider table lists,
// and the Messages client wants it with its version path.
export function resolveBaseUrl(selection: AgentSelection): string {
  const api = selectionApi(selection)
  const endpoints = findProvider(selection.providerId)?.endpoints ?? {}
  if (api === 'anthropic-messages') {
    const base = selection.baseUrl || endpoints.anthropic || 'https://api.anthropic.com'
    return `${base.replace(/\/+$/, '')}/v1`
  }
  if (selection.baseUrl) {
    return selection.baseUrl
  }
  const endpoint = (api === 'responses' ? endpoints['openai-responses'] : undefined) || endpoints.openai
  return endpoint || 'https://api.openai.com/v1'
}

// The headers every request carries: the key's Bearer shorthand with the
// selection's headers merged over it. The Messages API takes the key as a
// Bearer token too, as the Claude Code adapter sends it.
function requestHeaders(selection: AgentSelection): Record<string, string> {
  return mergeHeaders(selection.apiKey ? { Authorization: `Bearer ${selection.apiKey}` } : {}, selection.headers)
}

// The auth headers the OpenAI and Anthropic providers write themselves,
// cleared so `requestHeaders` is the only set sent. The providers spread their
// own headers over these case-sensitively, so a custom `authorization` would
// otherwise travel beside the key's instead of replacing it, and a selection
// with no key would send an empty one.
const PROVIDER_AUTH_CLEARED = { Authorization: undefined, 'x-api-key': undefined } as unknown as Record<
  string,
  string
>

// `model` overrides the profile's choice for one call, which is what a session's
// model config option sets and what a fan-out step passes to reach a smaller
// model on the same endpoint.
export function resolveModel(selection: AgentSelection, model = selection.model): LanguageModel {
  const baseURL = resolveBaseUrl(selection)
  const headers = requestHeaders(selection)
  switch (selectionApi(selection)) {
    case 'responses':
      return createOpenAI({ baseURL, apiKey: '', headers: { ...PROVIDER_AUTH_CLEARED, ...headers } }).responses(model)
    case 'anthropic-messages':
      return createAnthropic({ baseURL, apiKey: '', headers: { ...PROVIDER_AUTH_CLEARED, ...headers } })(model)
    default:
      return createOpenAICompatible({
        name: selection.providerId,
        baseURL,
        // Merged here rather than through the provider's `apiKey`: the provider
        // spreads its headers over its own case-sensitively, so a custom
        // `authorization` would be sent beside the shorthand instead of
        // replacing it.
        headers,
        // A streaming OpenAI-compatible response carries no token usage unless
        // it is asked for: this turns on `stream_options: { include_usage: true }`.
        // Without it a streamed turn reports no usage at all and the context
        // ring has nothing to render.
        includeUsage: true,
      })(model)
  }
}

/**
 * The output cap sent on the Anthropic Messages API, where `max_tokens` is
 * required. The client otherwise sends 4096 for any model its own table does
 * not know (every non-Anthropic model behind an Anthropic-compatible endpoint,
 * and Claude models newer than the client), which cuts a long tool call or
 * reply short. For a model it knows, the client lowers a larger cap to the
 * model's own maximum.
 *
 * Bound: at or under the smallest maximum output of the Claude 4 models the
 * client lists (32,000 for the Opus 4 and 4.1 models), so a model it does not
 * know is still asked for no more than any current Claude model writes.
 */
export const MESSAGES_MAX_OUTPUT_TOKENS = 32_000

// The output cap a call sends, where its API needs one stated.
export function maxOutputTokens(selection: AgentSelection): number | undefined {
  return selectionApi(selection) === 'anthropic-messages' ? MESSAGES_MAX_OUTPUT_TOKENS : undefined
}

// The provider options a call sends, keyed by the provider name the model was
// built under.
//
// Reasoning effort: `default` is the UI's way of saying "no preference" — it is
// not a literal effort value an endpoint accepts, so it resolves to sending
// nothing. `off` is an instruction to think as little as this endpoint allows,
// which no OpenAI endpoint spells as a literal value: it becomes the weakest
// grade the model takes (see leastEffort), or nothing at all for a model that
// does not think unless asked. `model` is the model the call will actually use
// — an override can move a profile onto a different scale than its own. The
// Messages API takes a thinking budget rather than an effort grade, so nothing
// is sent there.
//
// Responses: the conversation is sent whole on every call and nothing is kept
// on the provider's side (`store: false`). With that set, @ai-sdk/openai asks
// for the reasoning items back encrypted (`include`) on the models it counts
// as reasoning ones, so a later call can send them back; other models get no
// `include`.
export function callProviderOptions(
  selection: AgentSelection,
  effort = selection.reasoningEffort,
  model = selection.model,
): Record<string, Record<string, string | boolean>> | undefined {
  const api = selectionApi(selection)
  if (api === 'anthropic-messages') {
    return undefined
  }
  const effective = effort === 'off' ? leastEffort(model) : effort
  const reasoning: Record<string, string> =
    effective && effective !== 'default' ? { reasoningEffort: effective } : {}
  if (api === 'responses') {
    return { openai: { store: false, ...reasoning } }
  }
  return Object.keys(reasoning).length > 0 ? { [selection.providerId]: reasoning } : undefined
}

// What the endpoint reports about itself, cached per endpoint rather than per
// session.
//
// The harness caches this on the NativeSession, which is the right home while a
// session owns the conversation. An independent completion has no session, so
// the same lookup would refetch on every call — and the whole point of these
// completions is to fan several out at once. The cached value is the in-flight
// promise, so a fan-out that starts ten completions together makes one request.
//
// The key carries the api key and the request headers as well as the URL: one
// endpoint can serve a different catalog per credential (an aggregator gating
// models by plan), and keying on the URL alone would hand one caller another
// caller's answer.
const endpointModels = new Map<string, Promise<OpenAiModel[]>>()

function cacheKey(selection: AgentSelection): string {
  return JSON.stringify([resolveBaseUrl(selection), selection.apiKey, selection.headers ?? {}])
}

export function selectionModels(selection: AgentSelection): Promise<OpenAiModel[]> {
  const key = cacheKey(selection)
  const cached = endpointModels.get(key)
  if (cached) {
    return cached
  }
  const pending = discoverModels(resolveBaseUrl(selection), selection.apiKey, selection.headers).then((models) => {
    // An empty answer is dropped rather than cached. discoverModels never
    // throws — an unreachable endpoint and a silent one both come back as [] —
    // so caching it would let one transient failure claim for the rest of the
    // process that this endpoint serves no models. The session-scoped cache can
    // afford to keep [] because a session is short; this one outlives them all.
    if (models.length === 0) {
      endpointModels.delete(key)
    }
    return models
  })
  endpointModels.set(key, pending)
  return pending
}

// Discard what endpoints have reported. Tests use this to keep one case's
// stubbed catalog out of the next one's.
export function forgetEndpointModels(): void {
  endpointModels.clear()
}

// The window to report for a selection. A configured value wins: it is a
// deliberate override. 0 means unknown, which every surface renders as
// used-tokens alone rather than inventing a ratio.
export async function resolveSelectionContextWindow(
  selection: AgentSelection,
  model = selection.model,
): Promise<number> {
  if (selection.contextWindow) {
    return selection.contextWindow
  }
  return (await selectionModels(selection)).find((entry) => entry.id === model)?.contextWindow ?? 0
}
