import { agentAvatars } from '@pi-meme/assets/builtin'
import * as React from 'react'
import { cn } from '../lib/utils'

const roles = [
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
  ({ seed, name, className }: { seed: string; name?: string; className?: string }) => {
    // 未识别职责时用 agentId 稳定分配；同一身份续跑保留头像。
    let hash = 2166136261
    for (const character of seed) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0
    const variant = roles.find(({ pattern }) => pattern.test(name ?? ''))?.variant ?? hash % agentAvatars.length
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
