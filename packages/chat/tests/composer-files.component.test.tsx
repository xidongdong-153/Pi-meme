import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { createElement, StrictMode } from 'react'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import type { ChatFileUpload, ChatUploadedFile } from '@pi-meme/contracts/chat-attachments'
import type { ChatBridge } from '@pi-meme/contracts/desktop'
import { fileToAttachment, messageWithAttachments, type ComposerAttachment } from '../src/ui/composer/image-attachment'
import { useComposerFiles } from '../src/ui/composer/use-composer-files'
import { ComposerAttachments } from '../src/ui/composer/composer-attachments'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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

function previewFile(id: string): ComposerAttachment {
  return {
    id,
    type: 'file',
    name: `${id}.png`,
    path: `/host/${id}.png`,
    preview: new File(['png'], `${id}.png`, { type: 'image/png' }),
  }
}

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
