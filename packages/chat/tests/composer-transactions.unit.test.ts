import { describe, expect, test, vi } from 'vitest'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import type { ComposerRef, RegisteredBeforeSendHook } from '@pi-meme/plugin-sdk/composer'
import { skillMarker } from '@pi-meme/contracts/skills'
import { ComposerDraftStore } from '../src/ui/composer/composer-state'
import { applyComposerSteps, composerDocument, parseComposerDocument } from '../src/ui/composer/composer-document'
import { ComposerPipeline } from '../src/ui/composer/composer-submit'

const skill: PiSlashCommand = {
  name: 'skill:review',
  source: 'skill',
  resourceId: 'review',
  resourceRevision: 'r1',
  sourceInfo: { path: '/skills/review/SKILL.md', source: 'host', scope: 'user', origin: 'top-level' },
}
const ref: ComposerRef = {
  id: 'draft',
  epoch: 1,
  target: { kind: 'standalone-draft', draftKey: 'new' },
  context: { kind: 'draft' },
}
const input = { document: [{ kind: 'text' as const, text: '原稿' }], attachmentIds: [] }
function hook(id: string, process: RegisteredBeforeSendHook['process'], order = 0): RegisteredBeforeSendHook {
  return { id, title: id, pluginId: 'plugin', generation: 1, order, process }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Composer 唯一草稿事务', () => {
  test('文档投影保留技能和零正文宽度插件锚点，公开 token 宽度为一', () => {
    const store = new ComposerDraftStore()
    store.patch({
      draft: `a${skillMarker}b`,
      selectedSkills: [skill],
      pluginMentions: ['plugin'],
      pluginAnchors: { plugin: 1 },
    })
    const document = composerDocument(store.getSnapshot())
    expect(document.map((part) => part.kind)).toEqual(['text', 'agent-plugin', 'skill', 'text'])
    const parsed = parseComposerDocument(document, [skill], store.getSnapshot())
    expect(parsed.draft).toBe(`a${skillMarker}b`)
    expect(parsed.pluginAnchors).toEqual({ plugin: 1 })
    const changed = applyComposerSteps(
      store.getSnapshot(),
      [{ kind: 'replace', from: 3, to: 4, content: [{ kind: 'text', text: '正文' }] }],
      [skill],
    )
    expect(changed.draft).toBe(`a${skillMarker}正文`)
  })
  test('无效技能或切开代理对时整个事务失败，真实草稿不变', () => {
    const store = new ComposerDraftStore()
    store.setDraft('😀原稿')
    const source = store.getSnapshot()
    expect(() => applyComposerSteps(source, [{ kind: 'replace', from: 1, to: 2, content: [] }], [])).toThrow('Unicode')
    expect(() =>
      applyComposerSteps(
        source,
        [
          {
            kind: 'replace',
            from: 2,
            to: 4,
            content: [{ kind: 'skill', id: 'review', revision: 'old', name: 'review' }],
          },
        ],
        [skill],
      ),
    ).toThrow('失效')
    expect(store.getSnapshot()).toBe(source)
  })
  test('不能通过普通事务删除插件选择，移动选区不改变内容修订', () => {
    const store = new ComposerDraftStore()
    store.patch({ draft: '稿', pluginMentions: ['plugin'], pluginAnchors: { plugin: 0 } })
    const source = store.getSnapshot()
    expect(() => applyComposerSteps(source, [{ kind: 'replace', from: 0, to: 1, content: [] }], [])).toThrow('插件选择')
    store.setSelection({ anchor: 2, focus: 0 })
    expect(store.getSnapshot().revision).toBe(source.revision)
    expect(store.getSnapshot().selection).toMatchObject({ anchor: 2, focus: 0 })
  })
})

describe('Composer 发送前事务', () => {
  test('固定顺序，候选变化不改原稿，未选择的 hook 不执行', async () => {
    const pipeline = new ComposerPipeline()
    const calls: string[] = []
    const result = await pipeline.prepare({
      ref,
      intent: 'message',
      draft: input,
      signal: new AbortController().signal,
      validate: () => {},
      hooks: [
        hook(
          'second',
          () => {
            calls.push('second')
            return { kind: 'pass' }
          },
          2,
        ),
        hook(
          'first',
          ({ draft }) => {
            calls.push('first')
            return { kind: 'replace', input: { ...draft, document: [{ kind: 'text', text: '候选' }] } }
          },
          1,
        ),
        {
          ...hook('edit-only', () => {
            throw new Error('不应执行')
          }),
          intents: ['edit-message'],
        },
      ],
    })
    expect(calls).toEqual(['first', 'second'])
    expect(result?.input.document).toEqual([{ kind: 'text', text: '候选' }])
    expect(input.document[0]?.text).toBe('原稿')
  })
  test('处理期间取消丢弃晚结果，不产生发送候选', async () => {
    const pipeline = new ComposerPipeline()
    const pending = deferred<{ kind: 'pass' }>()
    const controller = new AbortController()
    const preparing = pipeline.prepare({
      ref,
      intent: 'message',
      draft: input,
      hooks: [hook('slow', () => pending.promise)],
      signal: controller.signal,
      validate: () => {},
    })
    controller.abort(new Error('用户继续输入'))
    pending.resolve({ kind: 'pass' })
    expect(await preparing).toBeNull()
  })
  test('失败重试从 checkpoint 开始，一次跳过不写长期设置', async () => {
    const pipeline = new ComposerPipeline()
    const first = vi.fn(() => ({ kind: 'pass' as const }))
    const failing = vi.fn(() => {
      throw new Error('查询失败')
    })
    const after = vi.fn(() => ({ kind: 'pass' as const }))
    await pipeline.prepare({
      ref,
      intent: 'message',
      draft: input,
      hooks: [hook('a', first), hook('b', failing), hook('c', after)],
      signal: new AbortController().signal,
      validate: () => {},
    })
    expect(pipeline.getSnapshot().status).toBe('blocked')
    await pipeline.retry()
    expect(first).toHaveBeenCalledTimes(1)
    expect(failing).toHaveBeenCalledTimes(2)
    const result = await pipeline.skip()
    expect(after).toHaveBeenCalledTimes(1)
    expect(result?.records.at(-2)).toMatchObject({
      hookId: 'b',
      outcome: 'skipped',
      userConfirmedAt: expect.any(String),
    })
    pipeline.cancel()
    expect(await pipeline.skip()).toBeNull()
  })
  test('失败 signal 仅属于当前失败 attempt，cancel 或新 attempt 使旧引用失效', async () => {
    const pipeline = new ComposerPipeline()
    const options = {
      ref,
      intent: 'message' as const,
      draft: input,
      hooks: [hook('block', () => ({ kind: 'block', reason: '需要用户决定' }))],
      signal: new AbortController().signal,
      validate: () => {},
    }
    await pipeline.prepare(options)
    const id = pipeline.getSnapshot().failure!.attemptId
    const signal = pipeline.getFailureSignal(id)!
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(pipeline.getFailureSignal('other-attempt')).toBeUndefined()
    pipeline.cancel()
    expect(signal.aborted).toBe(true)
    expect(pipeline.getFailureSignal(id)).toBeUndefined()
    await pipeline.prepare(options)
    const nextId = pipeline.getSnapshot().failure!.attemptId
    expect(nextId).not.toBe(id)
    expect(pipeline.getFailureSignal(id)).toBeUndefined()
    const nextSignal = pipeline.getFailureSignal(nextId)!
    expect(nextSignal.aborted).toBe(false)
    await pipeline.prepare(options)
    expect(nextSignal.aborted).toBe(true)
    pipeline.cancel()
  })
  test('候选新增未知附件被拒绝，后续 hook 不执行', async () => {
    const pipeline = new ComposerPipeline()
    const after = vi.fn(() => ({ kind: 'pass' as const }))
    const result = await pipeline.prepare({
      ref,
      intent: 'message',
      draft: input,
      hooks: [
        hook('a', () => ({ kind: 'replace', input: { document: input.document, attachmentIds: ['new-blob'] } })),
        hook('b', after),
      ],
      signal: new AbortController().signal,
      validate: (draft) => {
        if (draft.attachmentIds.length) throw new Error('只允许已有ready附件')
      },
    })
    expect(result).toBeNull()
    expect(after).not.toHaveBeenCalled()
    expect(pipeline.getSnapshot().failure?.reason).toContain('ready')
  })
  test('超时失败关闭而不是静默放行', async () => {
    vi.useFakeTimers()
    try {
      const pipeline = new ComposerPipeline()
      const prepared = pipeline.prepare({
        ref,
        intent: 'message',
        draft: input,
        hooks: [hook('slow', () => new Promise(() => {}))],
        signal: new AbortController().signal,
        validate: () => {},
      })
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await prepared).toBeNull()
      expect(pipeline.getSnapshot().failure?.reason).toContain('超时')
    } finally {
      vi.useRealTimers()
    }
  })
})
