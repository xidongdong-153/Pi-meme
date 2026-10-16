import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { DesktopSettings } from '@pi-meme/contracts/settings'
import { selectEnabledSubagentDefinitions } from '@pi-meme/host/runtime-extensions'

const definitions: Parameters<typeof selectEnabledSubagentDefinitions>[1] = [
  {
    id: 'worker',
    description: 'Worker',
    prompt: 'Work.',
    tools: ['read'],
    maxTurns: 8,
    path: '/tmp/worker.md',
  },
]

test('没有开启总开关或没有启用定义时不选择 SubAgent 扩展', () => {
  assert.deepEqual(selectEnabledSubagentDefinitions({ themeId: 'dark' }, definitions), [])
  assert.deepEqual(selectEnabledSubagentDefinitions({ themeId: 'dark', subagentsEnabled: true }, definitions), [])
  assert.deepEqual(
    selectEnabledSubagentDefinitions(
      { themeId: 'dark', subagentsEnabled: true, enabledSubagents: ['worker'] } satisfies DesktopSettings,
      definitions,
    ).map((definition) => definition.id),
    ['worker'],
  )
})
