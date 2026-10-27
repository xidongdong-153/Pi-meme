import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { createElement, StrictMode } from 'react'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import type { ChatFileUpload, ChatUploadedFile } from '@pi-meme/contracts/chat-attachments'
import type { ChatBridge } from '@pi-meme/contracts/desktop'
import {
  annotationAttachment,
  fileToAttachment,
  messageWithAttachments,
  type ComposerAttachment,
  type ComposerPendingAttachment,
} from '../src/ui/composer/image-attachment'
import { useComposerFiles } from '../src/ui/composer/use-composer-files'
import { ComposerAttachments } from '../src/ui/composer/composer-attachments'
import { useChatSession } from '../src/ui/use-chat-session'
import { queuedDraft } from '../src/ui/composer/restore-queued-input'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('输入框收起网页批注，展开后可编辑，移除全部不触及普通文件', async () => {
  const annotation = annotationAttachment({
    id: 'note-1',
    tabId: 'tab',
    documentId: 1,
    url: 'https://example.com/',
    title: '网页',
    capturedAt: new Date().toISOString(),
    kind: 'element',
    text: '内容',
    tag: 'div',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    viewport: { width: 100, height: 100, scale: 1, scrollX: 0, scrollY: 0 },
    comment: '原评论',
  })
  const file: ComposerAttachment = { id: 'file', type: 'file', name: 'report.pdf', path: '/host/report.pdf' }
  const remove = vi.fn()
  const change = vi.fn()
  const view = render(
    createElement(ComposerAttachments, {
      attachments: [annotation, file],
      onRemoveImage: remove,
      onAnnotationChange: change,
    }),
  )
  assert.ok(view.getByRole('button', { name: '查看 1 条批注' }))
  assert.ok(view.getByRole('button', { name: '移除文件：report.pdf' }))
  fireEvent.click(view.getByRole('button', { name: '查看 1 条批注' }))
  assert.ok(view.getByText('原评论'))
  fireEvent.click(view.getByRole('button', { name: '编辑第 1 条批注' }))
  fireEvent.change(view.getByRole('textbox', { name: '编辑批注评论' }), { target: { value: '新评论' } })
  fireEvent.click(view.getByRole('button', { name: '保存' }))
  assert.deepEqual(change.mock.calls[0], ['note-1', '新评论'])
  fireEvent.click(view.getByRole('button', { name: '移除全部浏览器批注' }))
  assert.deepEqual(remove.mock.calls, [['note-1']])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function filesHook(
  upload: ChatBridge['uploadAttachment'] = async (_session, input) => ({
    name: input.name,
    path: `/host/attachments/${input.name}`,
  }),
) {
  const added: ComposerAttachment[] = []
  const errors: string[] = []
  const notifications: string[] = []
  const uploads: Parameters<ChatBridge['uploadAttachment']>[] = []
  const options = {
    contextKey: 'history:100',
    sessionKey: 'session-a',
    disabled: false,
    uploadAttachment: (...args: Parameters<ChatBridge['uploadAttachment']>) => {
      uploads.push(args)
      return upload(...args)
    },
    onAdd: (attachments: ComposerAttachment[]) => added.push(...attachments),
    onError: (message: string) => {
      notifications.push(message)
      if (message) errors.push(message)
    },
  }
  const hook = renderHook(useComposerFiles, { initialProps: options })
  return { ...hook, options, added, errors, uploads, notifications }
}

test('所有新附件直接上传原始 File，图片仅保留本地预览对象', async () => {
  const uploads: ChatFileUpload[] = []
  const files = [
    new File(['png'], 'photo.png', { type: 'image/png' }),
    new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    new File(['webp'], 'PHOTO.WEBP'),
    new File(['pdf'], 'report.pdf', { type: 'application/pdf' }),
  ]
  const attachments = await Promise.all(
    files.map((file) =>
      fileToAttachment(file, async (input) => {
        uploads.push(input)
        return { name: input.name, path: `/host/attachments/${input.name}` }
      }),
    ),
  )
  assert.equal(uploads.length, files.length)
  for (let index = 0; index < files.length; index++) {
    assert.equal(uploads[index].data, files[index])
    assert.equal(attachments[index].type, 'file')
  }
  assert.equal(attachments[0].type === 'file' && attachments[0].preview, files[0])
  assert.equal(attachments[2].type === 'file' && attachments[2].preview, files[2])
  assert.equal(new Set(attachments.map(({ id }) => id)).size, files.length)
  const message = messageWithAttachments('按需读取', attachments)
  assert.deepEqual(message.images, [])
  for (const file of files) assert.ok(message.message.includes(`/host/attachments/${file.name}`))
  assert.doesNotMatch(message.message, /data:|blob:|base64/)
})

test('零字节文件原样上传，不被当作无效附件丢弃', async () => {
  const file = new File([], 'empty.txt')
  const attachment = await fileToAttachment(file, async (input) => {
    assert.equal(input.data, file)
    assert.equal(input.data.size, 0)
    return { name: input.name, path: '/host/attachments/empty.txt' }
  })
  assert.equal(attachment.type, 'file')
})

test('超过原 20 MiB 限制的文件仍原样上传，不在前端编码或读入内存', async () => {
  const file = new File([new Uint8Array(21 * 1024 * 1024)], 'installer.dmg')
  let uploads = 0
  const attachment = await fileToAttachment(file, async (input) => {
    uploads++
    assert.equal(input.data, file)
    return { name: input.name, path: '/host/attachments/installer.dmg' }
  })
  assert.equal(uploads, 1)
  assert.equal(attachment.type, 'file')
})

test.each([
  ['unknown.custom', ''],
  ['unknown.custom', 'application/x-custom'],
  ['drawing.svg', 'image/svg+xml'],
])('不限制上传的文件类型：%s %s', async (name, type) => {
  const file = new File(['content'], name, { type })
  const attachment = await fileToAttachment(file, async (input) => {
    assert.equal(input.data, file)
    return { name, path: `/host/attachments/${name}` }
  })
  assert.equal(attachment.type, 'file')
  assert.equal(attachment.name, name)
  if (attachment.type === 'file') assert.equal(attachment.preview, type.startsWith('image/') ? file : undefined)
})

test('发送新文件只引用 Host 路径，编辑已有图片消息时仍保留历史图片内容', () => {
  const image: ComposerAttachment = {
    id: 'image-1',
    type: 'image',
    name: 'photo.png',
    data: 'cG5n',
    mimeType: 'image/png',
  }
  const file: ComposerAttachment = {
    id: 'file-1',
    type: 'file',
    name: 'report.pdf',
    path: '/host/attachments/report.pdf',
  }
  const result = messageWithAttachments('请检查附件', [image, file])
  assert.ok(result.message.includes(JSON.stringify(file.path)))
  assert.deepEqual(result.images, [{ type: 'image', data: 'cG5n', mimeType: 'image/png' }])
  assert.doesNotMatch(result.message, /photo\.png|cG5n|image-1|file-1/)
  assert.deepEqual(messageWithAttachments('', [file]).images, [])
  assert.equal(messageWithAttachments('正文', [image]).message, '正文')
})

test.each(['string', 'parts'] as const)(
  '编辑 %s 用户消息时把 Host 附件恢复为卡片数据，重新发送不重复追加路径',
  async (contentType) => {
    const attachments: ComposerAttachment[] = [
      { id: 'photo', type: 'file', name: '图片.png', path: '/host/attachments/photo.png' },
      { id: 'document', type: 'file', name: '说明.pdf', path: '/host/attachments/report.pdf' },
    ]
    const original = messageWithAttachments('你好啊', attachments)
    const legacyImage = { type: 'image' as const, mimeType: 'image/png', data: 'cG5n' }
    const editAndPrompt = vi.fn<ChatBridge['editAndPrompt']>().mockResolvedValue({ recoveredInputs: [] })
    const uploadAttachment = vi.fn<ChatBridge['uploadAttachment']>()
    const hook = renderHook(() =>
      useChatSession({
        bridge: { editAndPrompt, uploadAttachment } as unknown as ChatBridge,
        commands: [],
        canSend: () => true,
        isSwitching: () => false,
        awaitPendingSwitch: async () => {},
        currentGeneration: () => 1,
        currentSessionKey: () => 'session-a',
        onError: () => {},
      }),
    )
    act(() => {
      hook.result.current.editMessage({
        role: 'user',
        timestamp: 100,
        sourceEntry: { id: 'entry-user', type: 'message', revision: '1' },
        content: contentType === 'string' ? original.message : [{ type: 'text', text: original.message }, legacyImage],
      })
    })
    assert.equal(hook.result.current.draft, '你好啊')
    assert.deepEqual(
      hook.result.current.attachments
        .filter((attachment) => attachment.type === 'file')
        .map(({ name, path }) => ({ name, path })),
      attachments.map((attachment) => ({
        name: attachment.name,
        path: attachment.type === 'file' ? attachment.path : '',
      })),
    )
    act(() => hook.result.current.setDraft('改一下正文'))
    await act(async () => hook.result.current.send())
    assert.deepEqual(editAndPrompt.mock.calls[0], [
      'session-a',
      'entry-user',
      messageWithAttachments('改一下正文', attachments).message,
      contentType === 'parts' ? [legacyImage] : [],
      [],
      { mode: 'default' },
    ])
    assert.equal(uploadAttachment.mock.calls.length, 0)
  },
)

test('编辑时可移除 Host 附件，发送失败保留修改，取消后恢复编辑前的草稿附件', async () => {
  const file: ComposerAttachment = { id: 'file', type: 'file', name: 'report.pdf', path: '/host/report.pdf' }
  const draftFile: ComposerAttachment = { id: 'draft', type: 'file', name: 'draft.txt', path: '/host/draft.txt' }
  const editAndPrompt = vi.fn<ChatBridge['editAndPrompt']>().mockRejectedValue(new Error('发送失败'))
  const hook = renderHook(() =>
    useChatSession({
      bridge: { editAndPrompt } as unknown as ChatBridge,
      commands: [],
      canSend: () => true,
      isSwitching: () => false,
      awaitPendingSwitch: async () => {},
      currentGeneration: () => 1,
      currentSessionKey: () => 'session-a',
      onError: () => {},
    }),
  )
  act(() => {
    hook.result.current.setDraft('编辑前草稿')
    hook.result.current.setAttachments([draftFile])
  })
  act(() =>
    hook.result.current.editMessage({
      role: 'user',
      timestamp: 100,
      sourceEntry: { id: 'entry-user', type: 'message', revision: '1' },
      content: messageWithAttachments('原消息', [file]).message,
    }),
  )
  const view = render(
    createElement(ComposerAttachments, {
      attachments: hook.result.current.attachments,
      onRemoveImage: (id) =>
        hook.result.current.setAttachments((current) => current.filter((attachment) => attachment.id !== id)),
    }),
  )
  fireEvent.click(view.getByRole('button', { name: '移除文件：report.pdf' }))
  await act(async () => hook.result.current.send())
  assert.equal(editAndPrompt.mock.calls[0][2], '原消息')
  assert.deepEqual(hook.result.current.attachments, [])
  assert.equal(hook.result.current.draft, '原消息')
  assert.equal(hook.result.current.editing, true)
  await act(async () => hook.result.current.cancelEdit())
  assert.equal(hook.result.current.draft, '编辑前草稿')
  assert.deepEqual(hook.result.current.attachments, [draftFile])
})

test('排队消息恢复时也分离 Host 附件，并保留原生图片', () => {
  const file: ComposerAttachment = { id: 'file', type: 'file', name: 'notes.txt', path: '/host/notes.txt' }
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'cG5n' }
  const restored = queuedDraft(
    { id: 'queued', text: messageWithAttachments('待发送', [file]).message, images: [image], mode: 'default' },
    [],
  )
  assert.equal(restored.draft, '待发送')
  assert.equal(restored.attachments.length, 2)
  assert.deepEqual(messageWithAttachments(restored.draft, restored.attachments), {
    message: messageWithAttachments('待发送', [file]).message,
    images: [image],
  })
})

test('读取或上传期间 pending 计数准确，同一 tick 即可阻止提交，全部完成后恢复', async () => {
  const first = deferred<ChatUploadedFile>()
  const second = deferred<ChatUploadedFile>()
  const hook = filesHook((_session, input) => (input.name === 'first.txt' ? first.promise : second.promise))
  let pending!: Promise<void>
  assert.equal(hook.result.current.isUploading(), false)
  act(() => {
    pending = hook.result.current.addFiles([new File(['first'], 'first.txt'), new File(['second'], 'second.txt')])
    assert.equal(hook.result.current.isUploading(), true, '渲染更新前提交守卫已生效')
  })
  assert.equal(hook.result.current.pending, 2)
  assert.equal(hook.result.current.uploading, true)
  await waitFor(() => assert.equal(hook.uploads.length, 1))
  assert.equal(hook.uploads[0][0], 'session-a')
  await act(async () => first.resolve({ name: 'first.txt', path: '/host/attachments/first.txt' }))
  await waitFor(() => assert.equal(hook.uploads.length, 2))
  assert.equal(hook.added.length, 1)
  assert.equal(hook.result.current.pending, 1)
  assert.equal(hook.result.current.isUploading(), true)
  await act(async () => {
    second.resolve({ name: 'second.txt', path: '/host/attachments/second.txt' })
    await pending
  })
  assert.equal(hook.added.length, 2)
  assert.equal(hook.result.current.pending, 0)
  assert.equal(hook.result.current.uploading, false)
  assert.equal(hook.result.current.isUploading(), false)
  assert.deepEqual(hook.errors, [])
})

test('上传开始立即出现文件卡片，真实进度更新后以同一附件替换，完成前不能发送', async () => {
  const upload = deferred<ChatUploadedFile>()
  const hook = filesHook(() => upload.promise)
  let pending!: Promise<void>
  act(() => {
    pending = hook.result.current.addFiles([new File(['content'], 'report.pdf')])
  })
  const id = hook.result.current.uploads[0].id
  const cards = () =>
    createElement(ComposerAttachments, {
      attachments: hook.added,
      uploads: hook.result.current.uploads,
      onRemoveImage: () => {},
      onCancelUpload: hook.result.current.cancelUpload,
    })
  const view = render(cards())
  assert.equal(view.getByRole('progressbar', { name: '上传文件：report.pdf' }).getAttribute('aria-valuenow'), '0')
  assert.equal(hook.result.current.isUploading(), true)
  act(() => hook.uploads[0][3]?.(46))
  view.rerender(cards())
  assert.equal(view.getByRole('progressbar').getAttribute('aria-valuenow'), '46')
  act(() => hook.uploads[0][3]?.(100))
  assert.equal(hook.result.current.isUploading(), true, '发送完字节后仍等待 Host 确认')
  await act(async () => {
    upload.resolve({ name: 'report.pdf', path: '/host/attachments/report.pdf' })
    await pending
  })
  view.rerender(cards())
  assert.equal(view.queryByRole('progressbar'), null)
  assert.equal(hook.added[0].id, id)
  assert.ok(view.getByRole('button', { name: '移除文件：report.pdf' }))
  assert.equal(hook.result.current.isUploading(), false)
})

test('从文件卡片取消单个上传不影响其余文件，晚到进度和结果不能恢复已取消附件', async () => {
  const first = deferred<ChatUploadedFile>()
  const second = deferred<ChatUploadedFile>()
  const hook = filesHook((_session, input) => (input.name === 'first.txt' ? first.promise : second.promise))
  let pending!: Promise<void>
  act(() => {
    pending = hook.result.current.addFiles([new File(['first'], 'first.txt'), new File(['second'], 'second.txt')])
  })
  const view = render(
    createElement(ComposerAttachments, {
      attachments: [],
      uploads: hook.result.current.uploads,
      onRemoveImage: () => {},
      onCancelUpload: hook.result.current.cancelUpload,
    }),
  )
  fireEvent.click(view.getByRole('button', { name: '取消上传：first.txt' }))
  assert.equal(hook.uploads[0][2]?.aborted, true)
  assert.equal(hook.result.current.pending, 1)
  act(() => hook.uploads[0][3]?.(80))
  assert.equal(hook.result.current.uploads[0].name, 'second.txt')
  assert.equal(hook.result.current.uploads[0].progress, 0)
  await act(async () => first.resolve({ name: 'first.txt', path: '/host/first.txt' }))
  await waitFor(() => assert.equal(hook.uploads.length, 2))
  assert.equal(hook.uploads[1][2]?.aborted, false)
  await act(async () => {
    second.resolve({ name: 'second.txt', path: '/host/second.txt' })
    await pending
  })
  assert.deepEqual(
    hook.added.map(({ name }) => name),
    ['second.txt'],
  )
  assert.deepEqual(hook.errors, [])
  assert.equal(hook.result.current.pending, 0)
})

test.each([
  ['切换会话', { sessionKey: 'session-b' }],
  ['切换历史消息编辑对象', { contextKey: 'history:200' }],
  ['切换排队消息编辑对象', { contextKey: 'queue:second' }],
  ['禁用输入框', { disabled: true }],
] as const)('%s 后晚到的上传成功或失败都不回填', async (label, changed) => {
  const success = deferred<ChatUploadedFile>()
  const failure = deferred<ChatUploadedFile>()
  const hook = filesHook((_session, input) => (input.name === 'success.txt' ? success.promise : failure.promise))
  if (label === '切换排队消息编辑对象') hook.options.contextKey = 'queue:first'
  hook.rerender(hook.options)
  let pending!: Promise<void[]>
  act(() => {
    pending = Promise.all([
      hook.result.current.addFiles([new File(['ok'], 'success.txt')]),
      hook.result.current.addFiles([new File(['bad'], 'failure.txt')]),
    ])
  })
  await waitFor(() => assert.equal(hook.uploads.length, 2))
  assert.equal(hook.result.current.pending, 2)
  hook.rerender({ ...hook.options, ...changed })
  assert.ok(hook.uploads.every((args) => args[2]?.aborted))
  assert.equal(hook.result.current.pending, 0)
  assert.equal(hook.result.current.isUploading(), false)
  await act(async () => {
    success.resolve({ name: 'success.txt', path: '/host/attachments/success.txt' })
    failure.reject(new Error('旧请求失败'))
    await pending
  })
  assert.deepEqual(hook.added, [])
  assert.deepEqual(hook.errors, [])
  assert.equal(hook.result.current.pending, 0)
})

test('卸载后忽略晚到的上传结果', async () => {
  const upload = deferred<ChatUploadedFile>()
  const hook = filesHook(() => upload.promise)
  let pending!: Promise<void>
  act(() => {
    pending = hook.result.current.addFiles([new File(['content'], 'file.txt')])
  })
  await waitFor(() => assert.equal(hook.uploads.length, 1))
  hook.unmount()
  assert.equal(hook.uploads[0][2]?.aborted, true)
  await act(async () => {
    upload.resolve({ name: 'file.txt', path: '/host/attachments/file.txt' })
    await pending
  })
  assert.deepEqual(hook.added, [])
  assert.deepEqual(hook.errors, [])
  assert.equal(hook.result.current.isUploading(), false)
})

test('旧会话晚到结果不清除新会话正在上传的计数', async () => {
  const oldUpload = deferred<ChatUploadedFile>()
  const newUpload = deferred<ChatUploadedFile>()
  const hook = filesHook((session) => (session === 'session-a' ? oldUpload.promise : newUpload.promise))
  let oldPending!: Promise<void>
  let newPending!: Promise<void>
  act(() => {
    oldPending = hook.result.current.addFiles([new File(['old'], 'old.txt')])
  })
  await waitFor(() => assert.equal(hook.uploads.length, 1))
  hook.rerender({ ...hook.options, sessionKey: 'session-b' })
  act(() => {
    newPending = hook.result.current.addFiles([new File(['new'], 'new.txt')])
  })
  await waitFor(() => assert.equal(hook.uploads.length, 2))
  await act(async () => {
    oldUpload.resolve({ name: 'old.txt', path: '/host/attachments/old.txt' })
    await oldPending
  })
  assert.equal(hook.result.current.pending, 1)
  assert.equal(hook.result.current.isUploading(), true)
  assert.deepEqual(hook.added, [])
  await act(async () => {
    newUpload.resolve({ name: 'new.txt', path: '/host/attachments/new.txt' })
    await newPending
  })
  assert.deepEqual(
    hook.added.map(({ name }) => name),
    ['new.txt'],
  )
  assert.equal(hook.result.current.pending, 0)
})

test('部分上传失败仍保留其他成功附件，错误汇总后解除上传状态', async () => {
  const hook = filesHook(async (_session, input) => {
    if (input.name === 'failed.txt') throw new Error('上传失败')
    return { name: input.name, path: `/host/attachments/${input.name}` }
  })
  await act(async () => {
    await hook.result.current.addFiles([
      new File(['first'], 'first.txt'),
      new File(['bad'], 'failed.txt'),
      new File(['last'], 'last.txt'),
    ])
  })
  assert.deepEqual(
    hook.added.map(({ name }) => name),
    ['first.txt', 'last.txt'],
  )
  assert.deepEqual(hook.errors, ['failed.txt：上传失败'])
  assert.equal(hook.result.current.pending, 0)
  assert.equal(hook.result.current.uploading, false)
})

test('已禁用时不读取或上传新文件', async () => {
  const hook = filesHook()
  hook.rerender({ ...hook.options, disabled: true })
  await act(async () => {
    await hook.result.current.addFiles([new File(['content'], 'file.txt')])
  })
  assert.deepEqual(hook.uploads, [])
  assert.deepEqual(hook.added, [])
  assert.deepEqual(hook.errors, [])
  assert.equal(hook.result.current.pending, 0)
})

test('重新添加附件清除旧错误，实际失败中的文件名不重复', async () => {
  const hook = filesHook(async () => {
    throw new Error('failed.txt 上传失败')
  })
  await act(async () => {
    await hook.result.current.addFiles([new File([], 'failed.txt')])
  })
  assert.deepEqual(hook.notifications, ['', 'failed.txt 上传失败'])
})

test('主动取消会中断上传并忽略晚到结果', async () => {
  const upload = deferred<ChatUploadedFile>()
  const hook = filesHook(() => upload.promise)
  let pending!: Promise<void>
  act(() => {
    pending = hook.result.current.addFiles([new File([], 'large.dmg')])
  })
  act(() => hook.result.current.cancel())
  assert.equal(hook.uploads[0][2]?.aborted, true)
  await act(async () => {
    upload.resolve({ name: 'large.dmg', path: '/host/attachments/large.dmg' })
    await pending
  })
  assert.deepEqual(hook.added, [])
  assert.deepEqual(hook.errors, [])
})

function mockObjectUrls() {
  let next = 0
  const create = vi.fn(() => `blob:test-${++next}`)
  const revoke = vi.fn()
  class PreviewURL extends URL {
    static createObjectURL = create
    static revokeObjectURL = revoke
  }
  vi.stubGlobal('URL', PreviewURL)
  return { create, revoke }
}

function previewFile(id: string, size?: number): ComposerAttachment {
  const file = new File(['png'], `${id}.png`, { type: 'image/png' })
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { value: size })
  }
  return {
    id,
    type: 'file',
    name: `${id}.png`,
    path: `/host/${id}.png`,
    preview: file,
  }
}

test('8 MiB 以上图片在发送前显示无法预览提示与卡片标记，不阻塞发送且普通图片与非图片无提示', () => {
  mockObjectUrls()
  const normal = previewFile('normal', 2 * 1024 * 1024)
  const large = previewFile('large', 10 * 1024 * 1024)
  const embeddedImage: ComposerAttachment = {
    id: 'embedded',
    type: 'image',
    data: 'a'.repeat(12 * 1024 * 1024),
    mimeType: 'image/png',
  }
  const pdf: ComposerAttachment = {
    id: 'doc',
    type: 'file',
    name: 'document.pdf',
    path: '/host/document.pdf',
  }
  const view = render(
    createElement(ComposerAttachments, {
      attachments: [normal, embeddedImage, pdf],
      onRemoveImage: () => {},
    }),
  )
  assert.equal(view.queryByText('图片超过 8 MiB，发送后无法在会话中预览。'), null)
  assert.equal(view.queryByText('超过 8 MiB 无法预览'), null)

  view.rerender(
    createElement(ComposerAttachments, {
      attachments: [normal, large, pdf],
      onRemoveImage: () => {},
    }),
  )
  assert.ok(view.getByText('图片超过 8 MiB，发送后无法在会话中预览。'))
  assert.ok(view.getByText('超过 8 MiB 无法预览'))
  const status = view.getByRole('status', { name: 'large.png：图片超过 8 MiB，发送后无法在会话中预览' })
  assert.ok(status)
})

test('超大图片移除后提示自动消失，处于上传中时同样展示超大提示', () => {
  mockObjectUrls()
  const largeUpload: ComposerPendingAttachment = {
    id: 'uploading-large',
    type: 'file',
    name: 'uploading.png',
    preview: (() => {
      const f = new File(['png'], 'uploading.png', { type: 'image/png' })
      Object.defineProperty(f, 'size', { value: 12 * 1024 * 1024 })
      return f
    })(),
    progress: 50,
  }
  const onRemoveImage = vi.fn()
  const onCancelUpload = vi.fn()
  const view = render(
    createElement(ComposerAttachments, {
      attachments: [],
      uploads: [largeUpload],
      onRemoveImage,
      onCancelUpload,
    }),
  )
  assert.ok(view.getByText('图片超过 8 MiB，发送后无法在会话中预览。'))
  assert.ok(view.getByText('超过 8 MiB 无法预览'))

  view.rerender(
    createElement(ComposerAttachments, {
      attachments: [],
      uploads: [],
      onRemoveImage,
      onCancelUpload,
    }),
  )
  assert.equal(view.queryByText('图片超过 8 MiB，发送后无法在会话中预览。'), null)
})

test('图片预览只使用本地blob URL，增删附件保留其他URL，回到草稿重新创建', () => {
  const urls = mockObjectUrls()
  const first = previewFile('first')
  const second = previewFile('second')
  const cards = (attachments: ComposerAttachment[]) =>
    createElement(ComposerAttachments, { attachments, onRemoveImage: () => {} })
  const view = render(cards([first]))
  const firstUrl = view.getByAltText('first.png').getAttribute('src')
  assert.equal(firstUrl, 'blob:test-1')
  view.rerender(cards([first, second]))
  assert.equal(view.getByAltText('first.png').getAttribute('src'), firstUrl)
  assert.equal(urls.create.mock.calls.length, 2)
  view.rerender(cards([first]))
  assert.deepEqual(urls.revoke.mock.calls, [['blob:test-2']])
  view.rerender(cards([]))
  assert.deepEqual(urls.revoke.mock.calls, [['blob:test-2'], [firstUrl]])
  view.rerender(cards([first]))
  assert.equal(view.getByAltText('first.png').getAttribute('src'), 'blob:test-3')
  view.unmount()
  assert.deepEqual(urls.revoke.mock.calls.at(-1), ['blob:test-3'])
})

test('StrictMode卸载撤销全部图片URL，解码失败回退文件图标而不丢附件', () => {
  const urls = mockObjectUrls()
  const file = previewFile('broken')
  const view = render(
    createElement(
      StrictMode,
      null,
      createElement(ComposerAttachments, { attachments: [file], onRemoveImage: () => {} }),
    ),
  )
  const image = view.getByAltText('broken.png')
  fireEvent.error(image)
  assert.equal(view.queryByAltText('broken.png'), null)
  assert.ok(view.getByRole('button', { name: '移除文件：broken.png' }))
  view.unmount()
  assert.equal(urls.create.mock.calls.length, urls.revoke.mock.calls.length)
})

test('运行中编辑已保存消息不会停止任务，取消后恢复原草稿', async () => {
  const pause = vi.fn()
  const abort = vi.fn()
  const hook = renderHook(() =>
    useChatSession({
      bridge: { pause, abort } as unknown as ChatBridge,
      commands: [],
      canSend: () => true,
      isSwitching: () => false,
      awaitPendingSwitch: async () => {},
      currentGeneration: () => 1,
      currentSessionKey: () => 'session-a',
      onError: () => {},
    }),
  )
  act(() => {
    hook.result.current.setDraft('尚未发送的草稿')
    hook.result.current.applyEvent({ type: 'agent_start' })
  })
  act(() =>
    hook.result.current.editMessage({
      role: 'user',
      timestamp: 100,
      content: '原消息',
      sourceEntry: { id: 'entry-user', type: 'message', revision: '1' },
    }),
  )
  assert.equal(hook.result.current.editing, true)
  assert.equal(hook.result.current.draft, '原消息')
  assert.equal(hook.result.current.chat.running, true)
  await act(async () => hook.result.current.cancelEdit())
  assert.equal(hook.result.current.draft, '尚未发送的草稿')
  assert.equal(pause.mock.calls.length, 0)
  assert.equal(abort.mock.calls.length, 0)
})
