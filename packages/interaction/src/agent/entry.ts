import type { InteractionPluginContext } from '@pi-meme/plugin-sdk/agent'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { validateUserInputQuestions } from '@pi-meme/contracts/user-input'

export function create(context: InteractionPluginContext): InlineExtension[] {
  context.registerInteractionPolicy(true)
  const text = () => Type.String({ minLength: 1 })
  return [
    {
      name: 'pi-meme-user-input',
      factory: (pi) => {
        pi.registerTool({
          name: 'request_user_input',
          label: '向用户提问',
          description:
            '向用户提出 1 到 3 道问题，等待用户逐题选择、输入或跳过。普通模式和规划模式均可使用；每道题使用唯一 id，选项可附说明，也允许用户自由输入。',
          parameters: Type.Object(
            {
              questions: Type.Array(
                Type.Object(
                  {
                    id: text(),
                    question: text(),
                    options: Type.Optional(
                      Type.Array(
                        Type.Object(
                          {
                            label: text(),
                            description: Type.Optional(text()),
                          },
                          { additionalProperties: false },
                        ),
                        { minItems: 1 },
                      ),
                    ),
                  },
                  { additionalProperties: false },
                ),
                { minItems: 1, maxItems: 3 },
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
