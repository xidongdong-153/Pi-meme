import { ProjectFileSearch } from './project-file-search'
import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import { message, text } from '@pi-meme/contracts/ipc'

export type ChatHandlerContext = { pi: PiRuntime; getCwd: () => string }

export function createChatHandlers({ pi, getCwd }: ChatHandlerContext) {
  const files = new ProjectFileSearch()
  const send =
    (operation: PiRuntime['prompt']) =>
    (sessionKey: unknown, value: unknown, valueImages: unknown, valueSkills: unknown) => {
      text(sessionKey)
      const parsed = message(value, valueImages, valueSkills)
      return operation(sessionKey, parsed.text, parsed.images, parsed.skills)
    }
  return {
    'pi:prompt': send(pi.prompt.bind(pi)),
    'pi:steer': send(pi.steer.bind(pi)),
    'pi:follow-up': send(pi.followUp.bind(pi)),
    'pi:clear-queue': (sessionKey: unknown) => {
      text(sessionKey)
      return pi.clearQueue(sessionKey)
    },
    'pi:steering-mode': (sessionKey: unknown, mode: unknown) => {
      text(sessionKey)
      if (mode !== 'all' && mode !== 'one-at-a-time') throw new Error('插话模式无效')
      return pi.setSteeringMode(sessionKey, mode)
    },
    'pi:follow-up-mode': (sessionKey: unknown, mode: unknown) => {
      text(sessionKey)
      if (mode !== 'all' && mode !== 'one-at-a-time') throw new Error('排队模式无效')
      return pi.setFollowUpMode(sessionKey, mode)
    },
    'chat:project-files': (cwd: unknown, query: unknown) => {
      text(cwd)
      if (cwd !== getCwd()) throw new Error('项目已切换，请重新选择文件')
      if (typeof query !== 'string' || query.length > 1024) throw new Error('文件搜索参数无效')
      return files.list(cwd, query)
    },
    'pi:commands': () => pi.getCommands(),
    'pi:abort': (sessionKey: unknown) => {
      text(sessionKey)
      return pi.abort(sessionKey)
    },
    'pi:edit-and-prompt': (
      sessionKey: unknown,
      valueTimestamp: unknown,
      value: unknown,
      images: unknown,
      skills: unknown,
    ) => {
      text(sessionKey)
      if (typeof valueTimestamp !== 'number' || !Number.isFinite(valueTimestamp)) throw new Error('用户消息时间无效')
      const parsed = message(value, images, skills)
      return pi.editAndPrompt(sessionKey, valueTimestamp, parsed.text, parsed.images, parsed.skills)
    },
    'pi:switch-message-version': (sessionKey: unknown, valueTimestamp: unknown, valueVersion: unknown) => {
      text(sessionKey)
      if (typeof valueTimestamp !== 'number' || !Number.isFinite(valueTimestamp)) throw new Error('用户消息时间无效')
      if (!Number.isInteger(valueVersion) || Number(valueVersion) < 0) throw new Error('消息版本无效')
      return pi.switchMessageVersion(sessionKey, valueTimestamp, Number(valueVersion))
    },
    'pi:fork-reply': (sessionKey: unknown, valueTimestamp: unknown) => {
      text(sessionKey)
      if (typeof valueTimestamp !== 'number' || !Number.isFinite(valueTimestamp)) throw new Error('用户消息时间无效')
      return pi.forkReply(sessionKey, valueTimestamp)
    },
  }
}
