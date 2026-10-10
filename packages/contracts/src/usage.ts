export type DailyTokenUsage = { date: string; tokens: number }

export type UsageStatsSnapshot = {
  updatedAt: string
  today: string
  totalTokens: number
  peakDailyTokens: number
  longestTaskMs: number | null
  longestStreak: number
  currentStreak: number
  daily: DailyTokenUsage[]
  warnings: string[]
}
