'use server'

export interface BasePrompt {
  positive_prompt: string
  negative_prompt: string
}

interface EnhancePromptParams {
  prompt: string
  instruction: string
}

export async function enhancePrompt(params: EnhancePromptParams): Promise<string> {
  return sendChatMessages([
    { role: 'system', content: params.instruction },
    { role: 'user', content: params.prompt },
  ])
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export async function sendChatMessages(messages: ChatMessage[], thinking = false): Promise<string> {
  console.log(messages)
  const response = await fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL,
      messages,
      ...(thinking && {
        reasoning: {
          effort: 'high',
          exclude: false,
          enabled: true,
        },
      }),
    }),
  })

  const data = await response.json()
  console.log(data)
  return data.choices?.[0]?.message?.content || ''
}
