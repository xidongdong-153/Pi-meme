import * as React from 'react'
import { cn } from '../lib/utils'

const colors = ['#69d9b0', '#56bfd0', '#e8a34e', '#a894e6', '#e385ac', '#72b5e8', '#b6ca68', '#dc9472']

function avatarShape(variant: number) {
  switch (variant) {
    case 0:
      return (
        <>
          <circle cx="16" cy="16" r="13" fillOpacity="0.2" />
          <circle cx="16" cy="16" r="11" fillOpacity="0.2" />
          {[0, 60, 120, 180, 240, 300].map((angle) => (
            <ellipse
              key={angle}
              cx="16"
              cy="11"
              rx="6"
              ry="7"
              transform={`rotate(${angle} 16 16)`}
              fillOpacity="0.12"
            />
          ))}
          <circle cx="16" cy="16" r="4" fillOpacity="0.45" />
        </>
      )
    case 1:
      return (
        <>
          <path d="M5 4h22L16 16 5 4Zm0 24h22L16 16 5 28Z" fillOpacity="0.75" />
          <path d="m5 4 11 24h11L16 4H5Z" fillOpacity="0.25" />
          <path d="m27 4-11 24H5L16 4h11Z" fillOpacity="0.25" />
        </>
      )
    case 2:
      return (
        <>
          {[0, 90, 180, 270].map((angle) => (
            <g key={angle} transform={`rotate(${angle} 16 16)`}>
              <path d="M16 16 4 12Q1 5 6 3q7 1 10 13Z" fillOpacity="0.8" />
              <path d="M16 16 6 3l10 6v7Z" fillOpacity="0.3" />
            </g>
          ))}
          <circle cx="16" cy="16" r="2" fillOpacity="0.8" />
        </>
      )
    case 3:
      return (
        <>
          <path d="m16 2 13 14-13 14L3 16 16 2Z" fillOpacity="0.3" />
          <path d="m16 2 4 14-4 14-4-14 4-14Z" fillOpacity="0.75" />
          <path d="m3 16 13-4 13 4-13 4-13-4Z" fillOpacity="0.5" />
        </>
      )
    case 4:
      return (
        <>
          {[0, 72, 144, 216, 288].map((angle) => (
            <path
              key={angle}
              d="M16 17C3 12 9-2 16 4c7-6 13 8 0 13Z"
              transform={`rotate(${angle} 16 16)`}
              fillOpacity="0.4"
            />
          ))}
          <circle cx="16" cy="16" r="4" fillOpacity="0.8" />
        </>
      )
    case 5:
      return (
        <>
          <circle cx="16" cy="16" r="11" fillOpacity="0.15" />
          {[0, 60, 120].map((angle) => (
            <ellipse
              key={angle}
              cx="16"
              cy="16"
              rx="14"
              ry="5"
              transform={`rotate(${angle} 16 16)`}
              fillOpacity="0.1"
            />
          ))}
          <circle cx="16" cy="16" r="3" fillOpacity="0.9" />
        </>
      )
    case 6:
      return (
        <>
          {[0, 120, 240].map((angle) => (
            <path key={angle} d="m16 2 12 21H4L16 2Z" transform={`rotate(${angle} 16 16)`} fillOpacity="0.25" />
          ))}
          <path d="m16 8 7 12H9l7-12Z" fillOpacity="0.6" />
        </>
      )
    default:
      return (
        <>
          {[0, 45, 90, 135].map((angle) => (
            <rect
              key={angle}
              x="12"
              y="3"
              width="8"
              height="26"
              rx="4"
              transform={`rotate(${angle} 16 16)`}
              fillOpacity="0.3"
            />
          ))}
          <circle cx="16" cy="16" r="4" fillOpacity="0.8" />
        </>
      )
  }
}

export const AgentAvatar = React.memo(({ seed, className }: { seed: string; className?: string }) => {
  // agentId 创建时随机生成；同一身份在列表、对话和续跑中使用同一图案。
  let hash = 2166136261
  for (const character of seed) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0
  const variant = hash % colors.length
  return (
    <svg
      aria-hidden
      data-agent-avatar=""
      data-variant={variant}
      viewBox="0 0 32 32"
      className={cn('size-6 shrink-0', className)}
      style={{ color: colors[variant] }}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinejoin="round"
    >
      {avatarShape(variant)}
    </svg>
  )
})
