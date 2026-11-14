import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  projectBranchVisualizations,
  visualizationMarkdown,
  validateVisualizationInput,
  validateVisualizationRef,
  type VisualizationRequest,
  type VisualizationDocument,
  type SaveVisualizationInput,
} from '@pi-meme/contracts/visualize'

export function create(context: {
  requestVisualization: (request: VisualizationRequest, signal?: AbortSignal) => Promise<VisualizationDocument>
}): InlineExtension[] {
  const reference = Type.Object(
    {
      id: Type.String({
        minLength: 36,
        maxLength: 36,
        pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
      }),
      revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  )
  return [
    {
      name: 'pi-meme-visualize',
      factory: (pi) => {
        pi.registerTool({
          name: 'save_visualization',
          label: '保存可视化',
          description:
            '生成或修改对话中的可视化，包括图表、模拟、交互讲解和 UI 预览。先阅读 visualize 技能。提交完整 HTML 片段、状态和控件；layout 可为 regular 或 wide，libraries 仅支持 echarts 且不能重复，由预览运行时提供库。不执行真实业务操作。Plan 允许保存可视化。更新必须提供 reference。保存成功后可用返回的 visualize 代码块引用。',
          parameters: Type.Object(
            {
              title: Type.String({ minLength: 1, maxLength: 120 }),
              description: Type.String({ minLength: 1, maxLength: 4000 }),
              html: Type.String({ minLength: 1, maxLength: 1048576 }),
              initialState: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
              controls: Type.Array(
                Type.Object(
                  {
                    type: Type.Union([
                      Type.Literal('select'),
                      Type.Literal('toggle'),
                      Type.Literal('slider'),
                      Type.Literal('color'),
                    ]),
                    key: Type.String({ minLength: 1, maxLength: 64 }),
                    label: Type.String({ minLength: 1 }),
                    options: Type.Optional(
                      Type.Array(
                        Type.Object({ label: Type.String(), value: Type.String() }, { additionalProperties: false }),
                        { minItems: 1, maxItems: 12 },
                      ),
                    ),
                    min: Type.Optional(Type.Number()),
                    max: Type.Optional(Type.Number()),
                    step: Type.Optional(Type.Number()),
                    unit: Type.Optional(Type.String()),
                  },
                  { additionalProperties: false },
                ),
                { maxItems: 12 },
              ),
              reference: Type.Optional(reference),
              layout: Type.Optional(Type.Union([Type.Literal('regular'), Type.Literal('wide')])),
              libraries: Type.Optional(Type.Array(Type.Literal('echarts'), { maxItems: 1, uniqueItems: true })),
            },
            { additionalProperties: false },
          ),
          execute: async (callId, input, signal, _update, ctx) => {
            validateVisualizationInput(input)
            const references = projectBranchVisualizations(
              ctx.sessionManager.getBranch(),
              ctx.sessionManager.getLeafId(),
            )
            const document = await context.requestVisualization(
              { action: 'save', input: input as SaveVisualizationInput, callId, references },
              signal,
            )
            const ref = { id: document.id, revision: document.revision }
            return {
              content: [{ type: 'text', text: `可视化已保存：${document.title}\n${visualizationMarkdown(ref)}` }],
              details: { visualization: { ...ref, title: document.title } },
            }
          },
        })
        pi.registerTool({
          name: 'read_visualization',
          label: '读取可视化',
          description: '读取当前分支可访问的指定可视化版本、状态、布局、库声明及 HTML 源码。',
          parameters: Type.Object({ reference }, { additionalProperties: false }),
          execute: async (_id, input, signal, _update, ctx) => {
            validateVisualizationRef(input.reference)
            const references = projectBranchVisualizations(
              ctx.sessionManager.getBranch(),
              ctx.sessionManager.getLeafId(),
            )
            const document = await context.requestVisualization(
              { action: 'read', reference: input.reference, references },
              signal,
            )
            return { content: [{ type: 'text', text: JSON.stringify(document) }], details: {} }
          },
        })
      },
    },
  ]
}
