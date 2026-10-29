import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  visualizationReferences,
  visualizationMarkdown,
  type VisualizationRequest,
  type VisualizationDocument,
  type SaveVisualizationInput,
} from '@pi-meme/contracts/visualize'

export function create(context: {
  requestVisualization: (request: VisualizationRequest, signal?: AbortSignal) => Promise<VisualizationDocument>
}): InlineExtension[] {
  const reference = Type.Object({ id: Type.String(), revision: Type.Integer({ minimum: 1 }) })
  return [
    {
      name: 'pi-meme-visualize',
      factory: (pi) => {
        pi.registerTool({
          name: 'save_visualization',
          label: '保存交互草图',
          description:
            '生成或修改对话中的交互 UI 草图。先阅读 visualize 技能。提交完整 HTML 片段、状态和控件；不执行真实业务操作。Plan 允许保存设计产物。更新必须提供 reference。保存成功后可用返回的 visualize 代码块在计划中引用。',
          parameters: Type.Object({
            title: Type.String(),
            description: Type.String(),
            html: Type.String(),
            initialState: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
            controls: Type.Array(
              Type.Object({
                type: Type.Union([
                  Type.Literal('select'),
                  Type.Literal('toggle'),
                  Type.Literal('slider'),
                  Type.Literal('color'),
                ]),
                key: Type.String(),
                label: Type.String(),
                options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), value: Type.String() }))),
                min: Type.Optional(Type.Number()),
                max: Type.Optional(Type.Number()),
                step: Type.Optional(Type.Number()),
                unit: Type.Optional(Type.String()),
              }),
            ),
            reference: Type.Optional(reference),
          }),
          execute: async (callId, input, signal, _update, ctx) => {
            const references = visualizationReferences(
              ctx.sessionManager.getBranch().flatMap((e) => (e.type === 'message' ? [e.message] : [])),
            )
            const document = await context.requestVisualization(
              { action: 'save', input: input as SaveVisualizationInput, callId, references },
              signal,
            )
            const ref = { id: document.id, revision: document.revision }
            return {
              content: [{ type: 'text', text: `草图已保存：${document.title}\n${visualizationMarkdown(ref)}` }],
              details: { visualization: { ...ref, title: document.title } },
            }
          },
        })
        pi.registerTool({
          name: 'read_visualization',
          label: '读取交互草图',
          description: '读取当前分支可访问的指定草图版本及源码。',
          parameters: Type.Object({ reference }),
          execute: async (_id, input, signal, _update, ctx) => {
            const references = visualizationReferences(
              ctx.sessionManager.getBranch().flatMap((e) => (e.type === 'message' ? [e.message] : [])),
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
