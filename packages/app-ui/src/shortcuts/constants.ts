import { SHORTCUT_DEFINITIONS, type ShortcutDefinition, type ShortcutId } from '@pi-meme/contracts/keyboard-shortcuts'

export type ShortcutMeta = {
  id: ShortcutId
  title: string
  scope: string
  group: 'chat' | 'navigation' | 'workspace'
}

export const SHORTCUT_META_MAP: Record<ShortcutId, ShortcutMeta> = {
  newChat: {
    id: 'newChat',
    title: '新建聊天',
    scope: '仅聊天页',
    group: 'chat',
  },
  searchSessions: {
    id: 'searchSessions',
    title: '搜索会话',
    scope: '仅聊天页',
    group: 'navigation',
  },
  openSettings: {
    id: 'openSettings',
    title: '打开设置',
    scope: '全局可用',
    group: 'navigation',
  },
  openShortcutHelp: {
    id: 'openShortcutHelp',
    title: '快捷键手册',
    scope: '全局可用',
    group: 'navigation',
  },
  focusComposer: {
    id: 'focusComposer',
    title: '聚焦聊天输入框',
    scope: '仅聊天页',
    group: 'chat',
  },
  toggleSidebar: {
    id: 'toggleSidebar',
    title: '展开／收起左侧栏',
    scope: '仅聊天页',
    group: 'workspace',
  },
  toggleFullView: { id: 'toggleFullView', title: '进入／退出完整视图', scope: '仅聊天页', group: 'workspace' },
  toggleTools: {
    id: 'toggleTools',
    title: '切换工具显示',
    scope: '仅聊天页',
    group: 'workspace',
  },
  pauseTask: {
    id: 'pauseTask',
    title: '暂停当前任务',
    scope: '仅聊天页 · 仅任务运行中',
    group: 'chat',
  },
  togglePlanMode: {
    id: 'togglePlanMode',
    title: '切换 Agent／Plan 模式',
    scope: '仅聊天页 · 仅空闲时',
    group: 'chat',
  },
  openModelPicker: {
    id: 'openModelPicker',
    title: '打开模型选择器',
    scope: '仅聊天页',
    group: 'chat',
  },
  openFiles: {
    id: 'openFiles',
    title: '打开文件面板',
    scope: '仅聊天页 · 会话或项目可用',
    group: 'workspace',
  },
  openTerminal: {
    id: 'openTerminal',
    title: '打开终端面板',
    scope: '仅聊天页 · 会话或项目可用',
    group: 'workspace',
  },
}

export const SHORTCUT_GROUPS: Array<{
  id: 'chat' | 'navigation' | 'workspace'
  label: string
  items: ShortcutDefinition[]
}> = [
  {
    id: 'chat',
    label: '聊天',
    items: SHORTCUT_DEFINITIONS.filter((item) => item.group === 'chat'),
  },
  {
    id: 'navigation',
    label: '导航',
    items: SHORTCUT_DEFINITIONS.filter((item) => item.group === 'navigation'),
  },
  {
    id: 'workspace',
    label: '工作区',
    items: SHORTCUT_DEFINITIONS.filter((item) => item.group === 'workspace'),
  },
]

export type ReadonlyEditingShortcut = {
  id: string
  title: string
  keybinding: string
  description: string
}

export const READONLY_EDITING_SHORTCUTS: ReadonlyEditingShortcut[] = [
  {
    id: 'send',
    title: '发送消息',
    keybinding: 'Enter',
    description: '输入框输入时发送，补全展开时优先确认补全',
  },
  {
    id: 'newline',
    title: '换行',
    keybinding: 'Shift+Enter',
    description: '在输入框中插入换行',
  },
  {
    id: 'complete-nav',
    title: '选择补全项',
    keybinding: '↑ / ↓',
    description: '在命令或文件补全列表中上下移动',
  },
  {
    id: 'complete-accept',
    title: '接受补全／输入预测',
    keybinding: 'Tab / Enter',
    description: '选中补全项或空草稿预测建议',
  },
  {
    id: 'dismiss',
    title: '关闭补全或取消编辑',
    keybinding: 'Escape',
    description: '关闭补全列表或退出历史消息编辑，不清空输入草稿',
  },
  {
    id: 'save-file',
    title: '保存文件',
    keybinding: 'Mod+S',
    description: '在文件编辑面板中保存当前修改',
  },
]
