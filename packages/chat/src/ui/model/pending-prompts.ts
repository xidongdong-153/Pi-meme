import type { PiImage, PiMessage } from '@pi-meme/contracts/pi'
import { skillMarker, type SkillReference } from '@pi-meme/contracts/skills'

export type PendingPrompt = {
  sessionKey: string
  sessionId?: string
  requestId: string
  message: Extract<PiMessage, { role: 'user' }>
  entryId?: string
}

export function confirmsPrompt(prompt: PendingPrompt, message: PiMessage) {
  const entry = message.sourceEntry
  return message.role === 'user' && entry && (entry.promptRequestId === prompt.requestId || entry.id === prompt.entryId)
}

/** 仅供发起窗口展示，正式消息仍由会话事件和快照维护。 */
export class PendingPrompts {
  private prompts: PendingPrompt[] = []
  private readonly listeners = new Set<() => void>()
  getSnapshot = () => this.prompts
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(prompts: PendingPrompt[]) {
    this.prompts = prompts
    for (const listener of this.listeners) listener()
  }
  forSession(key?: string) {
    return this.prompts.find((prompt) => prompt.sessionKey === key)
  }
  start(sessionKey: string, sessionId: string | undefined, text: string, images: PiImage[], skills: SkillReference[]) {
    let index = 0
    const preview = text.replaceAll(skillMarker, () => {
      const skill = skills[index++]
      return skill ? `$${skill.name.replace(/^skill:/, '')}` : ''
    })
    const prompt: PendingPrompt = {
      sessionKey,
      sessionId,
      requestId: crypto.randomUUID(),
      message: {
        role: 'user',
        timestamp: Date.now(),
        content: images.length ? [{ type: 'text', text: preview }, ...images] : preview,
      },
    }
    this.publish([...this.prompts, prompt])
    return prompt
  }
  remove(prompt: PendingPrompt) {
    if (this.prompts.includes(prompt)) this.publish(this.prompts.filter((item) => item !== prompt))
  }
  observe(key: string | undefined, messages: readonly PiMessage[], sessionId?: string) {
    for (const prompt of this.prompts) {
      if (prompt.sessionKey !== key && (!sessionId || prompt.sessionId !== sessionId)) continue
      const entry = messages.find((message) => confirmsPrompt(prompt, message))?.sourceEntry
      if (entry) {
        prompt.entryId = entry.id
        this.remove(prompt)
      }
    }
  }
}
