import { isTaskMode } from '@pi-meme/contracts/plan'
import { ProjectFileSearch } from './project-file-search'
import type { PiRuntime } from '@pi-meme/pi-runtime/runtime'
import { message, text, messageOptions } from '@pi-meme/contracts/ipc'

export type ChatHandlerContext = { pi: PiRuntime; getCwd: () => string }

export function createChatHandlers({ pi, getCwd }: ChatHandlerContext) {
  const files = new ProjectFileSearch()
  const send =
    (operation: PiRuntime['prompt']) =>
    (sessionKey: unknown, value: unknown, valueImages: unknown, valueSkills: unknown, options: unknown) => {
      text(sessionKey)
      const parsed = message(value, valueImages, valueSkills)
      return operation(sessionKey, parsed.text, parsed.images, parsed.skills, messageOptions(options))
    }
  return {
    'pi:prompt': send(pi.prompt.bind(pi)),
    'pi:steer': send(pi.steer.bind(pi)),
    'pi:follow-up': send(pi.followUp.bind(pi)),
    'pi:session-mode': (sessionKey: unknown, mode: unknown) => {
      text(sessionKey)
      if (!isTaskMode(mode)) throw new Error('会话模式无效')
      return pi.setSessionMode(sessionKey, mode)
    },
    'pi:pause': (key: unknown) => {
      text(key)
      return pi.pause(key)
    },
    'pi:resume': (key: unknown) => {
      text(key)
      return pi.resume(key)
    },
    'pi:recover': (key: unknown, failureEntryId: unknown) => {
      text(key)
      text(failureEntryId)
      return pi.recover(key, failureEntryId)
    },
    'pi:steer-queue-input': (key: unknown, id: unknown) => {
      text(key)
      text(id)
      return pi.steerQueueInput(key, id)
    },
    'pi:delete-queue-input': (key: unknown, id: unknown) => {
      text(key)
      text(id)
      return pi.deleteQueueInput(key, id)
    },
    'pi:begin-queue-edit': (key: unknown, id: unknown) => {
      text(key)
      text(id)
      return pi.beginQueueEdit(key, id)
    },
    'pi:cancel-queue-edit': (key: unknown, id: unknown) => {
      text(key)
      text(id)
      return pi.cancelQueueEdit(key, id)
    },
    'pi:update-queue-input': (
      key: unknown,
      id: unknown,
      value: unknown,
      images: unknown,
      skills: unknown,
      options: unknown,
    ) => {
      text(key)
      text(id)
      const parsed = message(value, images, skills)
      return pi.updateQueueInput(key, id, parsed.text, parsed.images, parsed.skills, messageOptions(options))
    },
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
      options: unknown,
    ) => {
      text(sessionKey)
      if (typeof valueTimestamp !== 'number' || !Number.isFinite(valueTimestamp)) throw new Error('用户消息时间无效')
      const parsed = message(value, images, skills)
      return pi.editAndPrompt(
        sessionKey,
        valueTimestamp,
        parsed.text,
        parsed.images,
        parsed.skills,
        messageOptions(options),
      )
    },
    'pi:fork-reply': (sessionKey: unknown, valueTimestamp: unknown) => {
      text(sessionKey)
      if (typeof valueTimestamp !== 'number' || !Number.isFinite(valueTimestamp)) throw new Error('用户消息时间无效')
      return pi.forkReply(sessionKey, valueTimestamp)
    },
  }
}
