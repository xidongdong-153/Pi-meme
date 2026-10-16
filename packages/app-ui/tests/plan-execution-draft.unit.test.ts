import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { PlanDocument } from '@pi-meme/contracts/plan'
import { planExecutionDraft } from '../src/plan-execution-draft'

test('继续计划保留已有输入、标题、修订和完整正文', () => {
  const document: PlanDocument = {
    id: 'plan',
    sessionId: 'session',
    runId: 'run',
    revision: 2,
    title: '新计划',
    markdown: '# 完整计划\n\n- 第一步\n- 第二步',
    updatedAt: '2026-10-10T00:00:00Z',
  }
  const draft = planExecutionDraft('已有要求  ', document)
  assert.ok(draft.startsWith('已有要求\n\n请按已保存的计划「新计划」（第 2 版）继续执行。'))
  assert.ok(draft.endsWith(document.markdown))
  assert.equal(
    planExecutionDraft('', document),
    `请按已保存的计划「新计划」（第 2 版）继续执行。\n\n${document.markdown}`,
  )
})
