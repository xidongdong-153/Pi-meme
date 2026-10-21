import '@testing-library/jest-dom/vitest'
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessageImageLoaderContext } from '@pi-meme/chat/ui/content/message-image'
import { SourcesPanel } from '../src/panels/sources-panel'
import type { SourceItem } from '../src/panels/sources-data'

afterEach(cleanup)

test('无附件时显示空状态', () => {
  render(<SourcesPanel sources={[]} />)
  expect(screen.getByRole('status')).toHaveTextContent('当前会话暂无附件')
})

test('展示附件文件名、路径与状态，点击图片缩略图打开图片预览对话框', async () => {
  const user = userEvent.setup()
  const sources: SourceItem[] = [
    {
      id: 'item1',
      name: 'codex-clipboard-test.png',
      path: '/var/folders/test/codex-clipboard-test.png',
      image: {
        type: 'image',
        mimeType: 'image/png',
        data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
      status: 'sent',
      statusText: '已附加到对话',
    },
    {
      id: 'item2',
      name: 'notes.txt',
      path: '/var/folders/test/notes.txt',
      status: 'draft',
      statusText: '待发送',
    },
  ]

  render(
    <MessageImageLoaderContext.Provider
      value={(relativePath: string) =>
        Promise.resolve({
          kind: 'image' as const,
          relativePath,
          dataUrl:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          size: 100,
        })
      }
    >
      <SourcesPanel sources={sources} />
    </MessageImageLoaderContext.Provider>,
  )

  expect(screen.getByText('codex-clipboard-test.png')).toBeInTheDocument()
  expect(screen.getByText('/var/folders/test/codex-clipboard-test.png')).toBeInTheDocument()
  expect(screen.getByText('已附加到对话')).toBeInTheDocument()

  expect(screen.getByText('notes.txt')).toBeInTheDocument()
  expect(screen.getByText('/var/folders/test/notes.txt')).toBeInTheDocument()
  expect(screen.getByText('待发送')).toBeInTheDocument()

  const previewButton = screen.getByRole('button', { name: '预览图片：codex-clipboard-test.png' })
  expect(previewButton).toBeInTheDocument()

  await user.click(previewButton)
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})
