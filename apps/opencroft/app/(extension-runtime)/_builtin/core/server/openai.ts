export interface OpenAIChatParams {
  apiBase: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
}

export interface OpenAIChatResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface OpenAIChoice {
  message: { content: string };
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

interface OpenAIResponse {
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
  error?: { message: string };
}

function buildMessages(system: string, user: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (system.trim()) {
    messages.push({ role: 'system', content: system });
  }
  messages.push({ role: 'user', content: user });
  return messages;
}

export async function openaiChat(params: OpenAIChatParams): Promise<OpenAIChatResult> {
  const base = (params.apiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const body = {
    model: params.model,
    messages: buildMessages(params.systemPrompt, params.userPrompt),
    temperature: params.temperature,
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (params.apiKey?.trim()) {
    headers['Authorization'] = `Bearer ${params.apiKey}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json() as OpenAIResponse;
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `HTTP ${res.status}`);
  }
  return {
    content: data.choices[0]?.message?.content ?? '',
    model: data.model,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}
