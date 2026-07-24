import type { ChatMessage } from '@/app/(agent)/_lib/messages'

export type DetailItem =
  | { kind: 'assistant-text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; result?: { text: string; isError?: boolean } }

// `id` is the originating ChatMessage's stable id (see ChatMessage.id) — used
// as the React key so a "load older" prepend, which shifts every subsequent
// block's ARRAY POSITION but not any message's id, doesn't force React to
// rewrite/reuse DOM nodes across the whole visible range. That churn is what
// defeated the scroll-position restore in practice.
export type Block = { id: number; kind: 'user'; text: string } | { id: number; kind: 'details'; items: DetailItem[] }

export function stripOpencroftTags(text: string): string {
  return text.replace(/<opencroft-[a-z0-9-]+>[\s\S]*?<\/opencroft-[a-z0-9-]+>\s*/gi, '')
}

export function buildBlocks(messages: ChatMessage[]): Block[] {
  const blocks: Block[] = []
  let details: DetailItem[] = []
  let detailsId: number | null = null
  const flush = () => {
    if (details.length === 0 || detailsId === null) {
      return
    }
    blocks.push({ id: detailsId, kind: 'details', items: details })
    details = []
    detailsId = null
  }
  for (const m of messages) {
    if (m.role === 'user') {
      flush()
      for (const p of m.parts) {
        if (p.type !== 'text') {
          continue
        }
        const v = stripOpencroftTags(p.text || '')
        if (!v.trim()) {
          continue
        }
        blocks.push({ id: m.id, kind: 'user', text: v })
      }
      continue
    }
    if (detailsId === null) {
      detailsId = m.id
    }
    for (const p of m.parts) {
      if (p.type === 'text') {
        const v = stripOpencroftTags(p.text || '…')
        if (!v.trim()) {
          continue
        }
        details.push({ kind: 'assistant-text', text: v })
      } else if (p.type === 'thinking') {
        if (!p.text.trim()) {
          continue
        }
        details.push({ kind: 'thinking', text: p.text })
      } else {
        details.push({ kind: 'tool', id: p.id, name: p.name, args: p.args, result: p.result })
      }
    }
  }
  flush()
  return blocks
}
