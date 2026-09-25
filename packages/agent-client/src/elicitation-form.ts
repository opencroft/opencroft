/**
 * The questions ⇄ ACP-elicitation-form conversion, in both directions.
 *
 * The wire conventions here mirror the AskUserQuestion bridges (claude-agent-acp
 * and its siblings), so a host's own question tool and an agent's ACP form
 * render through one component and answer through one shape:
 *
 * - fields are keyed `question_<n>`, options are a titled enum whose `const`
 *   IS the option label (that is what the answer records);
 * - each question is followed by its own optional free-text field
 *   `question_<n>_custom`, marked structurally via `_meta` so a renderer pairs
 *   it with its question rather than drawing it as a field of its own;
 * - nothing is required — the reader can skip, matching the built-in tools.
 *
 * Encoder and decoder live together for the same reason queue-tags' do: split
 * apart they drift, and a drifted pair silently loses answers. The readers of
 * per-field `_meta` markers live here too, because a renderer has to recognise
 * the markers other bridges stamp as well as the one this encoder does.
 */

import type { ElicitationContentValue, ElicitationSchema } from './types'

/**
 * The `_meta` key that marks a free-text field as some question's "Other" box,
 * naming the question field it belongs to. The cross-bridge convention —
 * claude-agent-acp stamps exactly this on the forms it builds, so one renderer
 * pairs customs for agent-sent and host-sent forms alike.
 */
export const CUSTOM_ANSWER_META_KEY = '_askUserQuestionCustomAnswer'

/**
 * The `_meta` key codex-acp stamps on the fields of a `request_user_input`
 * form: `{ isOther, isSecret }` on a question, and
 * `{ questionId, role: 'user_note', isSecret }` on the note field it adds
 * beside a question that accepts an answer outside its options.
 */
const CODEX_META_KEY = 'codex'

function metaEntry(property: unknown, key: string): Record<string, unknown> | undefined {
  const meta = (property as { _meta?: unknown } | null | undefined)?._meta
  const entry = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)[key] : undefined
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined
}

/**
 * The key of the question a field is the free-text answer box of, or null for
 * a field that is a question of its own. Either bridge convention marks one.
 * Only where it RENDERS moves: the box still answers under its own key, which
 * is the key the agent reads it back from.
 */
export function customAnswerTarget(property: unknown): string | null {
  const custom = metaEntry(property, CUSTOM_ANSWER_META_KEY)
  if (custom?.isCustomAnswer === true && typeof custom.questionId === 'string') {
    return custom.questionId
  }
  const codex = metaEntry(property, CODEX_META_KEY)
  if (codex?.role === 'user_note' && typeof codex.questionId === 'string') {
    return codex.questionId
  }
  return null
}

/** Whether a field asks for a secret, whose value must not be shown as typed. */
export function isSecretField(property: unknown): boolean {
  return metaEntry(property, CODEX_META_KEY)?.isSecret === true
}

export interface AskUserQuestionSpec {
  /** Short label — the tab caption, and the key the folded answers use. */
  title: string
  question: string
  options: string[]
  multiple?: boolean
}

function questionKey(index: number): string {
  return `question_${index}`
}

function customKey(index: number): string {
  return `${questionKey(index)}_custom`
}

/** Render question specs as an ACP form elicitation (message + schema). */
export function questionsToElicitation(questions: AskUserQuestionSpec[]): {
  message: string
  schema: ElicitationSchema
} {
  const single = questions.length === 1
  const properties: NonNullable<ElicitationSchema['properties']> = {}
  questions.forEach((question, index) => {
    const options = question.options.map((option) => ({ const: option, title: option }))
    // With one question the prompt is the form's own message; with several,
    // each field carries its question text.
    const description = single ? undefined : question.question
    properties[questionKey(index)] = question.multiple
      ? { type: 'array', title: question.title, description, items: { anyOf: options } }
      : { type: 'string', title: question.title, description, oneOf: options }
    properties[customKey(index)] = {
      type: 'string',
      title: 'Other',
      description: question.multiple
        ? 'Type your own answer to add to your selection above (optional).'
        : 'Type your own answer, or add a note to the option you chose above (optional).',
      _meta: { [CUSTOM_ANSWER_META_KEY]: { questionId: questionKey(index), isCustomAnswer: true } },
    }
  })
  return {
    message: single ? questions[0].question : 'Please answer the following questions.',
    schema: { type: 'object', properties },
  }
}

/**
 * Fold a form's accepted content back into per-question answers, keyed by the
 * question TITLE — the shape the ask_user tool has always reported
 * (`"question"="answer"` lines are built from it, and answer consumers read
 * `answers[title]`). Picks and a typed custom answer join with ', ', matching
 * the pre-form dialog; an unanswered question folds to ''.
 */
export function contentToAnswers(
  questions: AskUserQuestionSpec[],
  content: Record<string, ElicitationContentValue>,
): Record<string, string> {
  const answers: Record<string, string> = {}
  questions.forEach((question, index) => {
    const value = content[questionKey(index)]
    const picks =
      value === undefined || value === null ? [] : Array.isArray(value) ? value.map(String) : [String(value)]
    const custom = content[customKey(index)]
    const customText = typeof custom === 'string' ? custom.trim() : ''
    answers[question.title] = (customText ? [...picks, customText] : picks).join(', ')
  })
  return answers
}
