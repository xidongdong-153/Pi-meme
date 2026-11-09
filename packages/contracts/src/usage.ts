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
  /** Known memory tokens are included in totalTokens and daily; absent when the journal cannot be read. */
  memoryTotalTokens?: number
  memoryCalls?: number
  /** Attempts with unknown outcome or missing token usage; never represented as zero tokens. */
  memoryUnknownCalls?: number
  /** Sum of reported costs only; missing costs are counted separately. */
  memoryKnownCost?: number
  memoryUnknownCostCalls?: number
}
