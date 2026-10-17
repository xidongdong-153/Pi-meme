import { agentAvatars } from '@pi-meme/assets/builtin'
import { agentAvatarScenes, type AgentAvatarScene } from '@pi-meme/contracts/collaboration'
import * as React from 'react'
import { cn } from '../lib/utils'

const roles = [
  { variant: 8, pattern: /(?:^|[_-])(?:frontend|front_end|react|vue|svelte)(?:$|[_-])|前端/i },
  { variant: 9, pattern: /(?:^|[_-])(?:backend|back_end|api|server)(?:$|[_-])|后端|服务端/i },
  { variant: 10, pattern: /(?:^|[_-])(?:database|db|sql|storage|migration)(?:$|[_-])|数据库|存储|迁移/i },
  {
    variant: 11,
    pattern: /(?:^|[_-])(?:devops|ops|deploy|deployment|ci|cd|infra|infrastructure)(?:$|[_-])|部署|运维/i,
  },
  {
    variant: 12,
    pattern: /(?:^|[_-])(?:security|auth|authentication|authorization|permissions)(?:$|[_-])|安全|认证|权限/i,
  },
  { variant: 13, pattern: /(?:^|[_-])(?:debug|debugging|diagnose|bugfix)(?:$|[_-])|调试|故障|排障/i },
  { variant: 14, pattern: /(?:^|[_-])(?:performance|perf|benchmark|optimize|optimization)(?:$|[_-])|性能|基准/i },
  { variant: 15, pattern: /(?:^|[_-])(?:refactor|refactoring|cleanup)(?:$|[_-])|重构/i },
  { variant: 16, pattern: /(?:^|[_-])(?:browser|e2e|playwright|puppeteer)(?:$|[_-])|浏览器|端到端/i },
  { variant: 17, pattern: /(?:^|[_-])(?:data|analytics|etl)(?:$|[_-])|数据分析|数据处理/i },
  { variant: 18, pattern: /(?:^|[_-])(?:product|pm|requirements|prd)(?:$|[_-])|产品|需求/i },
  { variant: 19, pattern: /(?:^|[_-])(?:localization|l10n|i18n|translation|translate|locale)(?:$|[_-])|翻译|本地化/i },
  { variant: 4, pattern: /(?:^|[_-])(?:review|reviewer|audit)(?:$|[_-])|审查|评审|审核/i },
  { variant: 5, pattern: /(?:^|[_-])(?:test|tests|tester|testing|qa|debug)(?:$|[_-])|测试|调试/i },
  { variant: 6, pattern: /(?:^|[_-])(?:design|designer|ui|ux)(?:$|[_-])|设计|界面/i },
  { variant: 7, pattern: /(?:^|[_-])(?:doc|docs|documentation|readme)(?:$|[_-])|文档|说明书/i },
  { variant: 2, pattern: /(?:^|[_-])(?:plan|planner|planning|architect|architecture)(?:$|[_-])|规划|计划|架构/i },
  { variant: 3, pattern: /(?:^|[_-])(?:code|coder|coding|develop|developer|implement)(?:$|[_-])|编码|开发|实现/i },
  {
    variant: 1,
    pattern: /(?:^|[_-])(?:research|researcher|explore|explorer|scout|search)(?:$|[_-])|调研|研究|探索|检索/i,
  },
  { variant: 0, pattern: /(?:^|[_-])(?:general|helper|generalist)(?:$|[_-])|通用/i },
]

export const AgentAvatar = React.memo(
  ({
    seed,
    name,
    avatar,
    className,
  }: {
    seed: string
    name?: string
    avatar?: AgentAvatarScene
    className?: string
  }) => {
    // 未识别职责时保留最初 8 张头像的分配结果，扩充图库不改变旧身份的头像。
    let hash = 2166136261
    for (const character of seed) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0
    const configured = avatar ? agentAvatarScenes.indexOf(avatar) : -1
    const variant =
      configured >= 0 ? configured : (roles.find(({ pattern }) => pattern.test(name ?? ''))?.variant ?? hash % 8)
    return (
      <img
        aria-hidden
        alt=""
        data-agent-avatar=""
        data-variant={variant}
        src={agentAvatars[variant]}
        className={cn('size-6 shrink-0 object-contain', className)}
        draggable={false}
      />
    )
  },
)
