import type { AppearanceSettings, SettingsSnapshot } from '@pi-meme/contracts/settings'

/** 合并连续编辑；旧保存结果不覆盖新预览。 */
export class AppearanceSaver {
  private pending: AppearanceSettings | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private revision = 0
  constructor(
    private save: (value: AppearanceSettings) => Promise<SettingsSnapshot>,
    private accept: (value: SettingsSnapshot, current: boolean) => void,
    private fail: (cause: unknown, current: boolean) => void,
  ) {}
  schedule(value: AppearanceSettings) {
    this.pending = structuredClone(value)
    this.revision += 1
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush()
    }, 300)
  }
  flush(): Promise<void> {
    clearTimeout(this.timer)
    if (this.running) return this.running
    this.running = this.drain().finally(() => {
      this.running = undefined
    })
    return this.running
  }
  private async drain() {
    while (this.pending) {
      const value = this.pending
      const revision = this.revision
      this.pending = undefined
      try {
        this.accept(await this.save(value), revision === this.revision)
      } catch (cause) {
        this.fail(cause, revision === this.revision)
      }
    }
  }
}
