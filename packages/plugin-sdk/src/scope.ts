export type Disposer = () => void | Promise<void>

export class PluginScope {
  private effects: Disposer[] = []
  private disposal?: Promise<void>

  own(effect: Disposer): Disposer {
    if (this.disposal) throw new Error('插件已经开始释放资源')
    let active = true
    const once = async () => {
      if (!active) return
      active = false
      await effect()
    }
    this.effects.push(once)
    return once
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposal = this.release()
    return this.disposal
  }

  private async release() {
    const errors: unknown[] = []
    for (const effect of this.effects.splice(0).reverse()) {
      try {
        await effect()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, '插件资源释放失败')
  }
}
