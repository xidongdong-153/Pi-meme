import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import type { AgentAccessMode } from '@pi-meme/contracts/agent-access'
import type {
  ImageGenerationReply,
  ImageGenerationRequest,
  ImageGenerationResult,
} from '@pi-meme/contracts/image-generation'
import { Type } from 'typebox'
import { validateImageInput } from '../shared/input'
import { recentImageSources } from './recent-images'

type Context = {
  taskMode: () => 'default' | 'plan'
  accessMode: () => AgentAccessMode
  requestImageGeneration: (request: ImageGenerationRequest, signal?: AbortSignal) => Promise<ImageGenerationReply>
}

export function create(context: Context): InlineExtension[] {
  const permitted = () => context.taskMode() !== 'plan' && context.accessMode() !== 'read-only'
  return [
    {
      name: 'pi-meme-image-generation',
      factory: (pi) => {
        pi.registerTool({
          name: 'image_gen',
          label: '生成与编辑图片',
          description: [
            '根据提示词生成或编辑图片，结果保存到当前服务并显示在聊天中。使用设置页配置的默认图片模型。',
            '新图省略两种图片输入。编辑优先用 referenced_image_paths；所有目标都有设备路径时使用路径。',
            '编辑本地图片前，如当前模型支持视觉，应先用 read 查看图片。',
            '至少一个目标只有对话图片时，用 num_last_images_to_include 引用当前分支最近的最少张数，最多五张。',
            '两种图片输入不能同时使用：使用路径时，num_last_images_to_include 必须省略或为 null；使用最近图片时，referenced_image_paths 必须省略或为 null。',
            '新图的两种图片输入都省略或设为 null。缺少目标时请用户重新提供图片，不要用不相关图片代替。',
            '需要透明背景时设置 transparent_background=true；编辑省略时尽量保留背景属性。',
            '用户已要求生图或编辑时直接调用。失败后不要自动重试或更换模型，可能产生重复费用。',
            '返回图片已保存到附件目录，可直接在最终回复中用 Markdown 图片语法引用返回的绝对路径，无需复制到项目目录或重复读取。',
            '工具不可用于规划模式或只读模式。路径属于执行设备，可能与客户端不在同一台机器。',
          ].join('\n'),
          parameters: Type.Object(
            {
              prompt: Type.String({ minLength: 1, description: '生成目标或图片修改要求。' }),
              referenced_image_paths: Type.Optional(
                Type.Union(
                  [
                    Type.Array(Type.String({ minLength: 1 }), {
                      minItems: 1,
                      maxItems: 5,
                    }),
                    Type.Null(),
                  ],
                  { description: '当前服务的 1～5 个图片路径。相对路径按会话工作目录解析；不使用时省略或为 null。' },
                ),
              ),
              num_last_images_to_include: Type.Optional(
                Type.Union(
                  [
                    Type.Integer({
                      minimum: 1,
                      maximum: 5,
                    }),
                    Type.Null(),
                  ],
                  { description: '引用当前会话分支最近 N 张图片，与路径参数互斥；不使用时省略或为 null。' },
                ),
              ),
              transparent_background: Type.Optional(
                Type.Union([Type.Boolean(), Type.Null()], {
                  description: 'true 为透明背景；false 为不透明背景；省略或 null 使用默认背景行为。',
                }),
              ),
            },
            { additionalProperties: false },
          ),
          execute: async (_id, input, signal, update, ctx) => {
            if (!permitted()) throw new Error('当前任务模式或访问权限不允许生成图片')
            validateImageInput(input)
            const sources = input.referenced_image_paths
              ? input.referenced_image_paths.map((file) => ({ path: file }))
              : input.num_last_images_to_include
                ? recentImageSources(ctx.sessionManager.getBranch(), input.num_last_images_to_include)
                : []
            update?.({
              content: [{ type: 'text', text: sources.length ? '正在编辑图片…' : '正在生成图片…' }],
              details: {},
            })
            const result = (await context.requestImageGeneration(
              { action: 'generate', input, sources },
              signal,
            )) as ImageGenerationResult
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `图片已保存：${result.artifact.path}${result.retentionWarning ? `\n${result.retentionWarning}` : ''}`,
                },
                result.image,
              ],
              details: { artifact: result.artifact },
            }
          },
        })
        pi.on('before_agent_start', async () => {
          const reply = permitted() ? await context.requestImageGeneration({ action: 'ready' }) : undefined
          pi.setActiveTools([
            ...pi.getActiveTools().filter((name) => name !== 'image_gen'),
            ...(reply && 'ready' in reply && reply.ready ? ['image_gen'] : []),
          ])
        })
        pi.on('tool_call', (event) => {
          if (event.toolName === 'image_gen' && !permitted()) throw new Error('当前任务模式或访问权限不允许生成图片')
        })
      },
    },
  ]
}
