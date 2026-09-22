// How a selection becomes an endpoint and a model.
//
// Two callers resolve the same AgentSelection against the same OpenAI-compatible
// endpoints: the in-process agent loop (native-harness) and the independent
// completions (chat-completion). The resolution lives here once rather than
// being restated per caller — two definitions of "which URL does this profile
// talk to" drift the moment one gains a fallback the other lacks.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'

import { discoverModels, type OpenAiModel } from './models'
import { leastEffort } from './reasoning'
import { findProvider } from './resolve'
import type { AgentSelection } from './types'

// The harness reaches every provider through its OpenAI-compatible endpoint.
// A per-selection baseUrl override wins; otherwise the provider table endpoint;
// otherwise the public OpenAI default. Providers with no OpenAI endpoint
// (native-only Anthropic / Gemini) are unreachable here by design.
export function resolveBaseUrl(selection: AgentSelection): string {
  if (selection.baseUrl) {
    return selection.baseUrl
  }
  const provider = findProvider(selection.providerId)
  const endpoint = provider?.endpoints.openai
  if (endpoint) {
    return endpoint
  }
  if (provider && 'openai' in provider.endpoints) {
    return 'https://api.openai.com/v1'
  }
  throw new Error(
    `Provider "${selection.providerId}" has no OpenAI-compatible endpoint; the native harness only reaches OpenAI-compatible models.`,
  )
}

// `model` overrides the profile's choice for one call, which is what a session's
// model config option sets and what a fan-out step passes to reach a smaller
// model on the same endpoint.
export function resolveModel(selection: AgentSelection, model = selection.model): LanguageModel {
  const provider = createOpenAICompatible({
    name: selection.providerId,
    baseURL: resolveBaseUrl(selection),
    apiKey: selection.apiKey,
    // A streaming OpenAI-compatible response carries no token usage unless it
    // is asked for: this turns on `stream_options: { include_usage: true }`.
    // Without it a streamed turn reports no usage at all and the context ring
    // has nothing to render.
    includeUsage: true,
  })
  return provider(model)
}

// Reasoning effort as the OpenAI-compatible provider expects it, keyed by the
// provider name used in resolveModel. `default` is the UI's way of saying "no
// preference" — it is not a literal effort value an endpoint accepts, so it
// resolves to sending nothing.
//
// `off` is an instruction to think as little as this endpoint allows, which no
// OpenAI-compatible endpoint spells as a literal value: it becomes the weakest
// grade the model takes (see leastEffort), or nothing at all for a model that
// does not think unless asked. `model` is the model the call will actually
// use — an override can move a profile onto a different scale than its own.
export function reasoningProviderOptions(
  selection: AgentSelection,
  effort = selection.reasoningEffort,
  model = selection.model,
): Record<string, Record<string, string>> | undefined {
  const effective = effort === 'off' ? leastEffort(model) : effort
  if (!effective || effective === 'default') {
    return undefined
  }
  return { [selection.providerId]: { reasoningEffort: effective } }
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
// The key carries the api key as well as the URL: one endpoint can serve a
// different catalog per credential (an aggregator gating models by plan), and
// keying on the URL alone would hand one caller another caller's answer.
const endpointModels = new Map<string, Promise<OpenAiModel[]>>()

function cacheKey(selection: AgentSelection): string {
  return `${resolveBaseUrl(selection)}${selection.apiKey}`
}

export function selectionModels(selection: AgentSelection): Promise<OpenAiModel[]> {
  const key = cacheKey(selection)
  const cached = endpointModels.get(key)
  if (cached) {
    return cached
  }
  const pending = discoverModels(resolveBaseUrl(selection), selection.apiKey).then((models) => {
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
