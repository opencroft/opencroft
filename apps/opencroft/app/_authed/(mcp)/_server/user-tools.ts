/** The family that addresses the person at the screen: send_toast and ask_user. */

import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail, resolveSpace, SPACE_PARAM, textResult } from '@/app/_authed/(mcp)/_server/tool-shared'
import { askUserStore } from '@/lib/ask-user-store'
import type { SSEEvent } from '@/lib/sse-events'
import { toastStore } from '@/lib/toast-store'

export const sendToastDefinitions = [
  {
    name: 'send_toast',
    description: 'Show a toast notification in the OpenCroft browser UI via SSE.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Toast message text' },
        type: {
          type: 'string',
          enum: ['info', 'success', 'warning', 'error'],
          description: 'Toast type (default: "info")',
        },
        ...SPACE_PARAM,
      },
      required: ['message'],
    },
  },
]

export const askUserDefinitions = [
  {
    name: 'ask_user',
    description:
      'Ask the user structured questions with predefined options. Returns answers in "title"="answer" format. Up to 5 questions, each with up to 5 options plus a custom text input.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        questions: {
          type: 'array',
          description: 'Up to 5 questions to ask the user.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short title (1-2 words)' },
              question: { type: 'string', description: 'The question to ask' },
              options: {
                type: 'array',
                description: 'Up to 5 answer options',
                items: { type: 'string' },
                maxItems: 5,
              },
              multiple: { type: 'boolean', description: 'Allow multiple selection' },
            },
            required: ['title', 'question', 'options'],
          },
          maxItems: 5,
        },
        ...SPACE_PARAM,
      },
      required: ['questions'],
    },
  },
]

export const handlers: Record<string, ToolHandler> = {
  // ── send_toast ──────────────────────────────────────────────────
  send_toast: async (args) => {
    const message = args.message as string | undefined
    if (!message) {
      fail(-32602, 'Missing required param: message')
    }
    const type = (args.type as string) || 'info'
    const spaceId = args.space as string | undefined
    toastStore.broadcast({
      type: 'toast',
      message,
      toastType: type as 'info' | 'success' | 'warning' | 'error',
      ...(spaceId ? ({ spaceId } satisfies Pick<SSEEvent, 'spaceId'>) : {}),
    })
    return textResult(`Toast sent: [${type}] ${message}`)
  },

  // ── ask_user ──────────────────────────────────────────────────────────
  ask_user: async (args) => {
    const rawQuestions = args.questions as Array<Record<string, unknown>> | undefined
    if (!rawQuestions || !Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      fail(-32602, 'Missing required param: questions (non-empty array)')
    }
    if (rawQuestions.length > 5) {
      fail(-32602, 'Too many questions (max 5)')
    }

    const questions = rawQuestions.map((q) => ({
      title: String(q.title ?? ''),
      question: String(q.question ?? ''),
      options: (Array.isArray(q.options) ? q.options : []).map(String).slice(0, 5),
      multiple: Boolean(q.multiple),
    }))

    if (questions.some((q) => !q.title || !q.question || q.options.length === 0)) {
      fail(-32602, 'Each question must have title, question, and at least 1 option')
    }

    const spaceId = typeof args.space === 'string' ? await resolveSpace(args) : undefined
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

    const answers = await askUserStore.add({
      id,
      questions,
      spaceId,
      createdAt: Date.now(),
    })

    const lines = questions.map((q) => {
      const answer = answers[q.title] ?? ''
      return `"${q.question}"="${answer}"`
    })
    return textResult(`User answered to your questions:\n${lines.join('\n')}`)
  },
}
