export const features = {
  core: '主线：连接、聊天、会话恢复、队列与权限',
  chat: '聊天、输入、队列与问答',
  sessions: '会话、历史、分支与恢复',
  plan: '计划模式与计划文档',
  goals: '持久目标、自动续跑与用量',
  schedules: '定时任务、调度与运行记录',
  subagents: '子代理与协作',
  models: '模型配置与凭据',
  images: '图片生成、编辑与模型配置',
  plugins: 'App 插件与开发工具',
  skills: '技能与资源快照',
  mcp: 'MCP 配置与运行',
  permissions: '权限与平台沙箱',
  codemode: 'codemode 工具执行',
  workspace: '工作区与侧栏',
  git: 'Git 与 Worktree',
  files: '文件目录、预览与保存',
  terminal: '终端与 PTY',
  activities: 'Agent 项目服务与活动面板',
  settings: '设置、指令与外观',
  usage: '用量与统计',
  connection: '连接、认证与协议',
  desktop: '桌面壳、启动与产物',
  testing: '测试入口与清单',
} as const

export type Feature = keyof typeof features
export type Layer = 'unit' | 'component' | 'integration' | 'e2e' | 'artifact'
export interface TestSuite {
  file: string
  features: Feature[]
  layer: Layer
  target: 'shared' | 'web' | 'desktop' | 'server'
  platforms?: NodeJS.Platform[]
}

const files: Array<[string, Feature[]]> = []

export const suites: TestSuite[] = files.map(([file, features]) => {
  const layer = file.match(/\.(unit|component|integration|e2e|artifact)\./)![1] as Layer
  const target =
    layer === 'e2e' || layer === 'artifact'
      ? file.startsWith('apps/desktop/')
        ? 'desktop'
        : file.startsWith('apps/web/')
          ? 'web'
          : 'server'
      : 'shared'
  return {
    file,
    features,
    layer,
    target,
    ...(target === 'desktop'
      ? {
          platforms: [
            file === 'apps/desktop/tests/windows-runtime.artifact.test.ts' ? 'win32' : 'darwin',
          ] as NodeJS.Platform[],
        }
      : {}),
  }
})
