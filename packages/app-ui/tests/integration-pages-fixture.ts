import type { UiPluginDescriptor } from '@pi-meme/plugin-sdk/ui'

const plugin: UiPluginDescriptor = {
  id: 'example:app',
  version: '2.0.0',
  generation: 3,
  enabled: true,
  status: 'active',
  description: '示例 App 插件',
  capabilities: { server: true, agent: true, ui: true, resources: true },
}

export { plugin }
