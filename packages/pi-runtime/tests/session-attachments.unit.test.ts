import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { projectBranchAttachments } from '../src/session-attachments'
import { attachmentReferencesHeading } from '@pi-meme/contracts/chat-attachments'

function userEntry(
  id: string,
  parentId: string | null,
  content: string | Array<{ type: string; [key: string]: unknown }>,
): SessionEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: id,
    message: {
      role: 'user',
      timestamp: 1000,
      content,
    },
  } as unknown as SessionEntry
}

test('从分支用户消息中提取附加文件与图片', () => {
  const textWithFiles = [
    '请阅读附件',
    '',
    attachmentReferencesHeading,
    '- "doc.txt"："/workspace/doc.txt"',
    '- "photo.png"："/workspace/photo.png"',
  ].join('\n')

  const entries: SessionEntry[] = [
    userEntry('u1', null, textWithFiles),
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 'a1',
      message: { role: 'assistant', content: '好的', timestamp: 2000 },
    } as unknown as SessionEntry,
    userEntry('u2', 'a1', [
      { type: 'text', text: '补充图片' },
      { type: 'image', data: 'abc123base64', mimeType: 'image/png' },
    ]),
  ]

  const attachments = projectBranchAttachments(entries, 'u2')
  assert.equal(attachments.length, 3)
  assert.equal(attachments[0].name, 'doc.txt')
  assert.equal(attachments[0].path, '/workspace/doc.txt')
  assert.equal(attachments[1].name, 'photo.png')
  assert.equal(attachments[1].path, '/workspace/photo.png')
  assert.equal(attachments[2].name, '图片')
  assert.equal(attachments[2].image?.data, 'abc123base64')
})

test('排除不在当前活动分支上的其他分支附件', () => {
  const entries: SessionEntry[] = [
    userEntry('u1', null, `根消息\n\n${attachmentReferencesHeading}\n- "root.png"："/workspace/root.png"`),
    userEntry('branch_a', 'u1', `分支A\n\n${attachmentReferencesHeading}\n- "a.png"："/workspace/a.png"`),
    userEntry('branch_b', 'u1', `分支B\n\n${attachmentReferencesHeading}\n- "b.png"："/workspace/b.png"`),
  ]

  const fromA = projectBranchAttachments(entries, 'branch_a')
  assert.equal(fromA.length, 2)
  assert.deepEqual(
    fromA.map((a) => a.name),
    ['root.png', 'a.png'],
  )

  const fromB = projectBranchAttachments(entries, 'branch_b')
  assert.equal(fromB.length, 2)
  assert.deepEqual(
    fromB.map((a) => a.name),
    ['root.png', 'b.png'],
  )
})

test('context_edit 删除条目时忽略其附件，改写条目时使用更新后的内容', () => {
  const entries: SessionEntry[] = [
    userEntry('u1', null, `消息1\n\n${attachmentReferencesHeading}\n- "old.png"："/workspace/old.png"`),
    userEntry('u2', 'u1', `消息2\n\n${attachmentReferencesHeading}\n- "deleted.png"："/workspace/deleted.png"`),
    {
      type: 'context_edit',
      id: 'e1',
      parentId: 'u2',
      timestamp: 'e1',
      targetId: 'u2',
      replacement: null,
    } as unknown as SessionEntry,
    {
      type: 'context_edit',
      id: 'e2',
      parentId: 'e1',
      timestamp: 'e2',
      targetId: 'u1',
      replacement: {
        content: `更新后的消息1\n\n${attachmentReferencesHeading}\n- "updated.png"："/workspace/updated.png"`,
      },
    } as unknown as SessionEntry,
  ]

  const attachments = projectBranchAttachments(entries, 'e2')
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0].name, 'updated.png')
  assert.equal(attachments[0].path, '/workspace/updated.png')
})

test('压缩条目存在时仍完整保留压缩前的附件', () => {
  const entries: SessionEntry[] = [
    userEntry('u1', null, `较早的消息\n\n${attachmentReferencesHeading}\n- "early.png"："/workspace/early.png"`),
    {
      type: 'compaction',
      id: 'comp1',
      parentId: 'u1',
      timestamp: 'comp1',
      summary: '会话已压缩',
      firstKeptEntryId: 'u2',
      tokensBefore: 50000,
    } as unknown as SessionEntry,
    userEntry('u2', 'comp1', `压缩后的消息\n\n${attachmentReferencesHeading}\n- "recent.png"："/workspace/recent.png"`),
  ]

  const attachments = projectBranchAttachments(entries, 'u2')
  assert.equal(attachments.length, 2)
  assert.equal(attachments[0].name, 'early.png')
  assert.equal(attachments[1].name, 'recent.png')
})
