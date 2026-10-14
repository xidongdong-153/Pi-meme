import type { UiPluginDescriptor } from './ui'

export const systemPlugins: UiPluginDescriptor[] = [
  { id: '@pi-meme/git', display: { name: '变更' }, description: '查看当前会话目录的 Git 变更与文件差异。' },
  {
    id: '@pi-meme/file-directory',
    display: { name: '文件' },
    description: '浏览项目文件，编辑代码并预览 Markdown 和图片。',
  },
  { id: '@pi-meme/terminal', display: { name: '终端' }, description: '在当前会话目录中运行 shell，支持终端重连。' },
].map((plugin) => ({
  ...plugin,
  builtin: true,
  version: plugin.id === '@pi-meme/git' ? '0.0.0' : '0.1.0',
  generation: 1,
  enabled: true,
  status: 'active',
  capabilities: { server: false, agent: false, ui: true, resources: false },
}))

export const legacySystemPluginIds = ['@pi-meme/file-directory', '@pi-meme/terminal']
