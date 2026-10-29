import type { GitReviewQuery } from '@pi-meme/contracts/git-review'

export type ReviewScope = GitReviewQuery['scope'] | 'turn' | 'previous-turn'
export type ReviewLayout = 'auto' | 'unified' | 'split'
export type ProjectReviewPreferences = { scope: ReviewScope; branch?: string; commit?: string }
export type ReadingPreferences = { layout: ReviewLayout; wrap: boolean }

export const scopeLabels: Record<ReviewScope, string> = {
  turn: '本轮',
  'previous-turn': '上一轮',
  uncommitted: '未提交',
  unstaged: '未暂存',
  staged: '已暂存',
  commit: '已提交',
  branch: '分支',
}
const readingKey = 'pi-meme:git-reading:v1'

function read(key: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function saveReviewPreferences(key: string, value: ProjectReviewPreferences | ReadingPreferences) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储不可用时，当前面板仍保留本次选择。
  }
}

export function projectReviewKey(projectKey: string) {
  return `pi-meme:git-review:v1:${projectKey}`
}

export function readProjectReview(key: string): ProjectReviewPreferences {
  const value = read(key)
  return {
    scope:
      typeof value.scope === 'string' && Object.hasOwn(scopeLabels, value.scope)
        ? (value.scope as ReviewScope)
        : 'uncommitted',
    branch: typeof value.branch === 'string' ? value.branch : undefined,
    commit: typeof value.commit === 'string' ? value.commit : undefined,
  }
}

export function readReadingPreferences(): ReadingPreferences {
  const value = read(readingKey)
  return {
    layout: value.layout === 'unified' || value.layout === 'split' ? value.layout : 'auto',
    wrap: value.wrap !== false,
  }
}

export function saveReadingPreferences(value: ReadingPreferences) {
  saveReviewPreferences(readingKey, value)
}
