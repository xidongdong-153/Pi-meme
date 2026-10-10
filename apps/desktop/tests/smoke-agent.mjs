// @ts-check
// 桌面验收共用的 Pi 运行环境：本地假模型端点、隔离 agent 目录、技能与提示词 fixture。
import { cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeProvider } from '../../../tests/fixtures/fake-provider.mjs'

const fixtures = fileURLToPath(new URL('../../../tests/fixtures', import.meta.url))
export const smokeExtension = path.join(fixtures, 'smoke-extension.mjs')

/** 最后一条消息是工具结果时，说明本轮工具执行结束，可以收尾。 @param {any} body */
function lastIsToolResult(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages[messages.length - 1]?.role === 'tool'
}

/**
 * 本轮提示词文本。
 *
 * 跳过权限说明这类运行时注入的用户消息，只取用户实际输入的那条，避免历史消息命中其他场景。
 *
 * @param {any} body
 * @returns {string} 本轮提示词文本
 */
function promptText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const content = message.content
    const value =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((/** @type {any} */ part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
          : ''
    if (!value.startsWith('当前访问权限：')) return value
  }
  return ''
}

/**
 * 取最后一条指定角色的消息文本。
 *
 * @param {any} body
 * @param {string} role
 * @returns {string} 最后一条该角色消息的文本
 */
function lastText(body, role) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== role) continue
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content))
      return content.map((/** @type {any} */ part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
  }
  return ''
}

/**
 * 桌面验收默认回复：按提示词内容决定流式正文、工具调用和思考过程。
 *
 * @param {any} body
 * @returns {import('../../../tests/fixtures/fake-provider.mjs').FakeReply} 本次请求的回复
 */
export function smokeReply(body) {
  const text = promptText(body)
  // 工具结果回传后收尾：正文只出现在最后一个工具调用之后才会显示为最终正文。
  if (lastIsToolResult(body)) {
    const tool = lastText(body, 'tool')
    if (tool.startsWith('Script')) return { text: '嵌套调用验收完成' }
    // 延迟收尾，让验收脚本有机会断言运行中的界面状态。
    if (text === 'stream') return { text: '流式正文已生成', delayMs: 1500 }
    return { text: `模型收到：${tool}` }
  }
  if (text.includes('桌面验收'))
    return { thinking: '准备扩展交互', text: '扩展交互已发送', tool: { name: 'smoke-dialogs', arguments: '{}' } }
  if (text.includes('待处理验收'))
    return {
      text: '队列验收进行中',
      tool: { id: 'slow-1', name: 'slow-tool', arguments: JSON.stringify({ seconds: 60 }) },
    }
  if (text.includes('background-stream')) return { text: '后台流式正文', holdMs: 60_000 }
  if (text === 'stream')
    return {
      thinking: '检查项目文件',
      tool: { name: 'read', arguments: JSON.stringify({ path: 'src/main.ts' }) },
    }
  if (text.includes('long-conversation'))
    return { text: Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段滚动验收内容。`).join('\n\n') }
  if (text.includes('codemode-smoke'))
    return {
      tool: {
        id: 'code-smoke',
        name: 'codemode',
        arguments: JSON.stringify({
          code: 'await tools.write({ path: "codemode-smoke.txt", content: "codemode" })\ntext(await tools.read({ path: "codemode-smoke.txt" }))',
        }),
      },
    }
  return { text: `已回复：${text}` }
}

/**
 * 启动假模型端点并准备 Desktop 专属运行目录，返回供验收使用的路径。
 *
 * 目录内写入 `models.json`、`skills/` 和 `prompts/`；调用方负责关闭返回的 provider。
 *
 * @param {string} directory 验收临时根目录
 * @param {{ picker?: boolean; emptyModels?: boolean }} [options] picker 为真时额外提供 18 个滚动验收模型；emptyModels 为真时不预置模型服务商
 * @returns {Promise<{ agentDir: string; modelsFile: string; provider: Awaited<ReturnType<typeof startFakeProvider>> }>}
 *   agentDir 为 Desktop 应用数据中的 Pi 运行目录，modelsFile 为模型配置文件路径
 */
export async function startSmokeAgent(directory, options = {}) {
  const provider = await startFakeProvider({ reply: smokeReply })
  const agentDir = path.join(directory, 'pi')
  await mkdir(agentDir, { recursive: true })
  const models = [
    { id: 'first', name: '模型 first', reasoning: true },
    { id: 'second', name: '模型 second', reasoning: true },
  ]
  const providers = {
    ...(options.emptyModels
      ? {}
      : { fake: { name: '本地验收接口', api: 'openai-completions', baseUrl: provider.baseUrl, models } }),
    ...(options.picker
      ? {
          'picker-test': {
            name: '滚动验收服务',
            api: 'openai-completions',
            baseUrl: provider.baseUrl,
            models: Array.from({ length: 18 }, (_, index) => ({
              id: `picker-${index + 1}`,
              name: `picker-${index + 1}`,
              reasoning: true,
            })),
          },
        }
      : {}),
  }
  const modelsFile = path.join(agentDir, 'models.json')
  await writeFile(modelsFile, JSON.stringify({ providers }))
  await cp(path.join(fixtures, 'skills'), path.join(agentDir, 'skills'), { recursive: true })
  await mkdir(path.join(agentDir, 'prompts'), { recursive: true })
  for (let index = 1; index <= 12; index += 1) {
    await writeFile(
      path.join(agentDir, 'prompts', `fixture-${index}.md`),
      `---\ndescription: 滚动验收命令 ${index}\n---\n\n滚动验收提示 ${index}\n`,
    )
  }
  return { agentDir, modelsFile, provider }
}
