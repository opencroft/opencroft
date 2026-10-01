/**
 * Forms real bridges send, for the tests on both sides of the elicitation
 * contract: the client that raises and settles an ask, and the renderer that
 * draws it and builds the answer. One copy, so the two sides are tested
 * against the same form.
 */

import type { ElicitationSchema } from './types'

/**
 * What claude-agent-acp 0.84.0 sends for an AskUserQuestion with two questions,
 * to a client that is not JetBrains AIR: each question is followed by its
 * `question_<n>_custom` "Other" box, and nothing marks the box as belonging to
 * its question — the `_meta` marker goes to AIR clients only. Printed from the
 * package's own `askUserQuestionsToCreateRequest` over:
 *
 *   { question: 'Which approach?', header: 'Approach', multiSelect: false,
 *     options: [{ label: 'Fast', description: 'Ship it today' },
 *               { label: 'Thorough', description: '' }] }
 *   { question: 'Which parts?', header: 'Scope', multiSelect: true,
 *     options: [{ label: 'Engine', description: '' }, { label: 'UI', description: '' }] }
 *
 * The adapter reads the answer back from `question_<n>` and `question_<n>_custom`.
 */
export const CLAUDE_ASK_USER_QUESTION_FORM = {
  message: 'Please answer the following questions.',
  requestedSchema: {
    type: 'object',
    properties: {
      question_0: {
        type: 'string',
        title: 'Approach',
        description: 'Which approach?',
        oneOf: [
          { const: 'Fast', title: 'Fast', description: 'Ship it today' },
          { const: 'Thorough', title: 'Thorough' },
        ],
      },
      question_0_custom: {
        type: 'string',
        title: 'Other',
        description: 'Type your own answer, or add a note to the option you chose above (optional).',
      },
      question_1: {
        type: 'array',
        title: 'Scope',
        description: 'Which parts?',
        items: {
          anyOf: [
            { const: 'Engine', title: 'Engine' },
            { const: 'UI', title: 'UI' },
          ],
        },
      },
      question_1_custom: {
        type: 'string',
        title: 'Other',
        description: 'Type your own answer to add to your selection above (optional).',
      },
    },
  } satisfies ElicitationSchema,
}

/**
 * What codex-acp sends for a `request_user_input` with two questions: one with
 * options that also accepts an answer outside them, and one secret free-text
 * question. Built by hand from `buildUserInputRequest` in codex-acp's
 * `src/CodexElicitationHandler.ts` (1.13.1) over these question params
 * (`src/app-server/v2/ToolRequestUserInputQuestion.ts`):
 *
 *   { id: 'target', header: 'Target', question: 'Where should this deploy?',
 *     isOther: true, isSecret: false,
 *     options: [{ label: 'Staging', description: 'The shared staging stack' },
 *               { label: 'Production', description: '' }] }
 *   { id: 'token', header: 'Token', question: 'Paste the deploy token',
 *     isOther: false, isSecret: true, options: null }
 *
 * Codex reads the answer back in `convertUserInputResponse` from the question's
 * own key and from `<id>_note`, the note prefixed `user_note: `, so those are
 * the keys an answer must use.
 */
export const CODEX_USER_INPUT_FORM = {
  message: 'Codex needs your input to continue.',
  requestedSchema: {
    type: 'object',
    properties: {
      target: {
        title: 'Where should this deploy?',
        description: 'Target',
        _meta: { codex: { isOther: true, isSecret: false } },
        type: 'string',
        oneOf: [
          { const: 'Staging', title: 'Staging', description: 'The shared staging stack' },
          // An empty option description is left out, not sent as ''.
          { const: 'Production', title: 'Production' },
          // Appended because the question accepts an answer outside its options.
          {
            const: 'None of the above',
            title: 'None of the above',
            description: 'Provide a different answer in the note field.',
          },
        ],
      },
      target_note: {
        type: 'string',
        title: 'Additional answer or note',
        _meta: { codex: { questionId: 'target', role: 'user_note', isSecret: false } },
      },
      token: {
        title: 'Paste the deploy token',
        description: 'Token',
        _meta: { codex: { isOther: false, isSecret: true } },
        type: 'string',
      },
    },
    // Every question id, the note fields never.
    required: ['target', 'token'],
  } satisfies ElicitationSchema,
  // `autoResolutionMs` is the question's own timeout: when it fires, codex-acp
  // aborts the request and answers Codex itself. The abort arrives as a
  // `$/cancel_request` that the SDK's client dispatch never passes on to
  // createElicitation, so the ask stays open until its turn ends.
  _meta: { codex: { autoResolutionMs: 60000 } },
}
