import { useEffect, useState } from 'react'
import { request } from '../client/api'
import type { Memory, Snapshot } from '../shared/types'
import { Field, Form, Input, Select, Textarea } from './common'

export function MemoryEditor({
  item,
  defaults,
  snapshot,
  close,
  refresh,
  onDirtyChange,
  onSavingChange,
}: {
  item?: Memory
  defaults?: Partial<Memory>
  snapshot: Snapshot
  close: () => void
  refresh: () => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  onSavingChange?: (saving: boolean) => void
}) {
  const [initial] = useState(() => ({ ...defaults, ...item }))
  const [title, setTitle] = useState(initial.title ?? '')
  const [content, setContent] = useState(initial.content ?? '')
  const [scope, setScope] = useState(initial.scope ?? 'owner')
  const [target, setTarget] = useState(initial.targetId ?? '')
  const dirty =
    title !== (initial.title ?? '') ||
    content !== (initial.content ?? '') ||
    scope !== (initial.scope ?? 'owner') ||
    target !== (initial.targetId ?? '')
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  return (
    <Form
      onCancel={() => {
        if (!dirty || confirm('放弃尚未保存的记忆修改？')) close()
      }}
      onSubmit={async () => {
        onSavingChange?.(true)
        try {
          await request(item ? `/memories/${item.id}` : '/memories', {
            method: item ? 'PATCH' : 'POST',
            body: {
              revision: initial.revision,
              title,
              content,
              scope,
              targetId: scope === 'owner' ? undefined : target,
              sourceMessageId: initial.sourceMessageId,
            },
          })
          await refresh().catch(() => {})
          close()
        } finally {
          onSavingChange?.(false)
        }
      }}
    >
      <Field label="标题">
        <Input autoFocus required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label="范围">
        <Select
          value={scope}
          onChange={(value) => {
            setScope(value as Memory['scope'])
            setTarget('')
          }}
        >
          <option value="owner">个人共享</option>
          <option value="bot">Bot 专属</option>
          <option value="conversation">会话</option>
        </Select>
      </Field>
      {scope !== 'owner' && (
        <Field label="所属对象">
          <Select value={target} onChange={setTarget} required>
            <option value="">请选择</option>
            {(scope === 'bot' ? snapshot.bots : snapshot.conversations).map((value) => (
              <option key={value.id} value={value.id}>
                {value.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="内容" hint="最多 16000 字符">
        <Textarea required maxLength={16000} value={content} onChange={(event) => setContent(event.target.value)} />
      </Field>
    </Form>
  )
}
