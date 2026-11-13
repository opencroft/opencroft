import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { type OpenAIChatParams, requestChat } from './openai-chat'

async function serve(listener: RequestListener): Promise<{ apiBase: string; close: () => Promise<void> }> {
  const server = createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    apiBase: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function chat(apiBase: string): Promise<unknown> {
  const params: OpenAIChatParams = {
    apiBase,
    apiKey: '',
    model: 'test-model',
    systemPrompt: '',
    userPrompt: 'Hello',
    temperature: 0,
  }
  return requestChat(params, '')
}

// The problem a failed chat throws, which the host records on the node and
// answers an agent's `call` with.
async function problemOfFailing(apiBase: string): Promise<unknown> {
  let thrown: unknown
  await assert.rejects(chat(apiBase), (err) => {
    thrown = err
    return true
  })
  return (thrown as { problem?: unknown }).problem
}

test('an endpoint nothing listens on is a problem naming it and the API Base to check', async () => {
  const { apiBase, close } = await serve(() => {})
  await close()
  assert.deepEqual(await problemOfFailing(apiBase), {
    title: "Can't reach the model endpoint",
    detail: `${apiBase}/chat/completions: connect ECONNREFUSED ${new URL(apiBase).host}`,
    next: "Check the AI Assistant's API Base and that the server behind it is running.",
  })
})

test("a refusal is a problem in the endpoint's words, with its status and the setting to check", async () => {
  const { apiBase, close } = await serve((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }))
  })
  try {
    assert.deepEqual(await problemOfFailing(apiBase), {
      title: 'The model endpoint refused the request',
      detail: 'Incorrect API key provided.',
      code: 'HTTP 401',
      next: "Check the AI Assistant's API Key.",
    })
  } finally {
    await close()
  }
})

test('an answer that is not JSON is a problem saying the API Base is not an OpenAI API', async () => {
  const { apiBase, close } = await serve((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' })
    res.end('<html>Not here</html>')
  })
  try {
    assert.deepEqual(await problemOfFailing(apiBase), {
      title: 'The model endpoint did not answer as an OpenAI API',
      detail: `${apiBase}/chat/completions answered HTTP 404 with no JSON reply.`,
      next: "Check that the AI Assistant's API Base is the API's root, such as https://api.openai.com/v1.",
    })
  } finally {
    await close()
  }
})

test('a problem carries no credentials from the API Base', async () => {
  const { apiBase, close } = await serve(() => {})
  await close()
  const host = new URL(apiBase).host
  const problem = (await problemOfFailing(`http://alice:s3cret@${host}/v1`)) as { detail?: string }
  assert.ok(problem.detail?.startsWith(`http://${host}/v1/chat/completions: `), problem.detail)
  assert.doesNotMatch(problem.detail ?? '', /alice|s3cret/)
})

test('an answer the endpoint gives is returned as the reply', async () => {
  const { apiBase, close } = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        model: 'test-model',
        choices: [{ message: { content: 'Hi' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    )
  })
  try {
    assert.deepEqual(await chat(apiBase), { content: 'Hi', model: 'test-model', promptTokens: 3, completionTokens: 1 })
  } finally {
    await close()
  }
})
