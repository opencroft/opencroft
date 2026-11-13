// How the pictures a tool returned reach the model.
//
// A conversation keeps a tool's pictures where the tool put them: inside its
// result, as `image-data` content parts (`toolModelOutput`). That is the shape
// an API taking pictures inside a tool result sends as it is (Responses'
// `function_call_output`, an Anthropic `tool_result`). Each request is shaped
// from it here, for the API it goes to and for whether its model takes
// pictures at all, and the conversation itself is never rewritten: a model
// switched mid-session, or a later request to another API, starts again from
// the pictures as the tool returned them.

import type { ModelMessage, ToolContent, UserContent } from 'ai'

import type { ToolOutput } from './tool-result'
import type { NativeApi } from './types'

type ToolMessage = Extract<ModelMessage, { role: 'tool' }>
type ToolPart = ToolContent[number]
type ContentValue = Extract<ToolOutput, { type: 'content' }>['value']
type ImagePart = Extract<ContentValue[number], { type: 'image-data' }>

function isImagePart(part: ContentValue[number]): part is ImagePart {
  return part.type === 'image-data'
}

function partImages(part: ToolPart): ImagePart[] {
  return part.type === 'tool-result' && part.output.type === 'content' ? part.output.value.filter(isImagePart) : []
}

function hasToolImages(message: ModelMessage): boolean {
  return message.role === 'tool' && message.content.some((part) => partImages(part).length > 0)
}

// The size of a base64 payload in bytes, without decoding it.
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** What a picture is, as one line of text: its type and size, and what became of it. */
function imageLine(part: ImagePart, fate?: string): string {
  const what = `image ${part.mediaType}, ${sizeLabel(base64Bytes(part.data))}`
  return fate ? `[${what}, ${fate}]` : `[${what}]`
}

/**
 * A tool result's content parts as text, each picture as a line saying what
 * it was (`fate`, when given, says what became of it). Parts this module does
 * not produce are written as JSON, as the Chat Completions converter writes a
 * whole content result.
 */
export function toolContentText(value: ContentValue, fate?: string): string {
  return value
    .map((part) => (part.type === 'text' ? part.text : isImagePart(part) ? imageLine(part, fate) : JSON.stringify(part)))
    .join('\n')
}

function withTextOutput(part: ToolPart, fate: string): ToolPart {
  if (part.type !== 'tool-result' || part.output.type !== 'content') {
    return part
  }
  return { ...part, output: { type: 'text', value: toolContentText(part.output.value, fate) } }
}

function textOnly(message: ToolMessage, fate: string): ToolMessage {
  return { ...message, content: message.content.map((part) => withTextOutput(part, fate)) }
}

const NOT_SHOWN = 'not shown: this model does not take images'
const SHOWN_BELOW = 'attached in the message after the tool results'
const IMAGES_PREAMBLE = 'The images returned by the tool calls above, in the order they were called.'

/**
 * The conversation for a model that takes no pictures: each picture a tool
 * returned becomes a line in its result saying what it was. The same array
 * when there is none.
 */
export function withoutToolImages(messages: ModelMessage[]): ModelMessage[] {
  if (!messages.some(hasToolImages)) {
    return messages
  }
  return messages.map((message) => (message.role === 'tool' ? textOnly(message, NOT_SHOWN) : message))
}

// The position of each call in the step that made it, by call id.
function callOrder(assistant: ModelMessage | undefined): Map<string, number> {
  const order = new Map<string, number>()
  if (assistant?.role === 'assistant' && typeof assistant.content !== 'string') {
    for (const part of assistant.content) {
      if (part.type === 'tool-call') {
        order.set(part.toolCallId, order.size)
      }
    }
  }
  return order
}

/**
 * The conversation for a model reached over Chat Completions that takes
 * pictures. A `tool` message carries text only there, so each picture is a line
 * in its result, and the pictures themselves follow the step's tool results
 * in one `user` message, in the order the step called the tools. The same
 * array when there is none.
 */
export function toolImagesAfterResults(messages: ModelMessage[]): ModelMessage[] {
  if (!messages.some(hasToolImages)) {
    return messages
  }
  const shaped: ModelMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== 'tool') {
      shaped.push(message)
      continue
    }
    // One step's results: this tool message and any that directly follow it.
    // The pictures go after the last of them, since an assistant's calls must
    // be answered by the tool messages right after it.
    const step: ToolMessage[] = [message]
    for (let next = messages[index + 1]; next?.role === 'tool'; next = messages[index + 1]) {
      step.push(next)
      index++
    }
    const order = callOrder(shaped.at(-1))
    const position = (part: ToolPart) =>
      part.type === 'tool-result' ? (order.get(part.toolCallId) ?? order.size) : order.size
    const images = step
      .flatMap((toolMessage) => toolMessage.content)
      .map((part, at) => ({ part, at }))
      .sort((a, b) => position(a.part) - position(b.part) || a.at - b.at)
      .flatMap(({ part }) => partImages(part))
    shaped.push(...step.map((toolMessage) => textOnly(toolMessage, SHOWN_BELOW)))
    if (images.length > 0) {
      const content: UserContent = [
        { type: 'text', text: IMAGES_PREAMBLE },
        ...images.map((image) => ({ type: 'image' as const, image: image.data, mediaType: image.mediaType })),
      ]
      shaped.push({ role: 'user', content })
    }
  }
  return shaped
}

/**
 * The conversation as a request to `api` sends it. A model that takes no
 * pictures gets a line for each, on every API. One that does gets them where
 * its API carries them: inside the tool result on Responses
 * (`function_call_output` with `input_image` parts) and Anthropic Messages
 * (`tool_result` with `image` blocks), which the stored form already is; after
 * the step's tool results on Chat Completions.
 */
export function requestMessages(api: NativeApi, messages: ModelMessage[], takesImages: boolean): ModelMessage[] {
  if (!takesImages) {
    return withoutToolImages(messages)
  }
  return api === 'chat-completions' ? toolImagesAfterResults(messages) : messages
}
