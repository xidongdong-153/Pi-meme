import type { InteractionPluginContext } from '@pi-meme/plugin-sdk/agent'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { validateUserInputQuestions } from '@pi-meme/contracts/user-input'

export function create(context: InteractionPluginContext): InlineExtension[] {
  context.registerInteractionPolicy(true)
  const text = (description: string) => Type.String({ minLength: 1, description })
  return [
    {
      name: 'pi-meme-user-input',
      factory: (pi) => {
        pi.registerTool({
          name: 'request_user_input',
          label: '向用户提问',
          description:
            'Ask 1–3 focused questions and wait for the user to answer, choose an option, or skip. Available in default and Plan modes when the client supports interactive input. Use a unique id for each question. Omit options for free-text questions; supplied options must have unique labels within each question. Inspect cancelled and each answer value; null means skipped. A skipped or cancelled answer is not approval.',
          parameters: Type.Object(
            {
              questions: Type.Array(
                Type.Object(
                  {
                    id: text('Non-empty question identifier, unique within this request and returned with the answer.'),
                    question: text('The question to show to the user, in the requested language.'),
                    options: Type.Optional(
                      Type.Array(
                        Type.Object(
                          {
                            label: text('Non-empty option label, unique within this question.'),
                            description: Type.Optional(text('Optional non-empty explanation of this option.')),
                          },
                          { additionalProperties: false },
                        ),
                        {
                          minItems: 1,
                          description:
                            'Suggested choices. Omit for free text; when supplied, include at least one option. The user may also enter a custom answer.',
                        },
                      ),
                    ),
                  },
                  { additionalProperties: false },
                ),
                {
                  minItems: 1,
                  maxItems: 3,
                  description: 'One to three questions with distinct ids. The user may answer or skip each question.',
                },
              ),
            },
            { additionalProperties: false },
          ),
          execute: async (_id, input, signal, _update, toolContext) => {
            validateUserInputQuestions(input.questions)
            if (!toolContext.hasUI) throw new Error('当前客户端无法回答交互问题')
            const result = await context.requestUserInput(input.questions, signal)
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
          },
        })
      },
    },
  ]
}
