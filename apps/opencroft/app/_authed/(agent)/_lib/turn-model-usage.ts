import type { TurnQuota, TurnTokenUsage } from 'agent-client/types'

/**
 * A turn's token spend, by model: the harness's per-model breakdown when its
 * `_meta` carried one, or else the turn's own usage standing in as its only
 * row under the turn's model.
 *
 * The breakdown is the fuller figure. A claude turn's own usage counts the
 * main agent loop only, while its breakdown also counts subagents, sidechains
 * and internal calls such as compaction, so a turn that delegated spends more
 * than its own usage says. Everything that counts a turn's tokens goes through
 * here: what is recorded per model, and what a live session adds for a turn it
 * watched finish, so the two agree.
 */
export function turnModelUsage(
  usage: TurnTokenUsage,
  quota: TurnQuota | undefined,
  model: string | undefined,
): { model: string | null; tokenCount: TurnTokenUsage }[] {
  return quota?.modelUsage?.length ? quota.modelUsage : [{ model: model ?? null, tokenCount: usage }]
}
