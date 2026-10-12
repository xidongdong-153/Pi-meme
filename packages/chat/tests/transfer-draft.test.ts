import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import { transferDraft } from '../src/ui/composer/transfer-draft'

test('跨项目草稿使用目标技能对象，失效技能转文字，图片和队列模式保留', () => {
  const source: PiSlashCommand[] = [
    {
      name: 'skill:shared',
      resourceId: 'shared-id',
      resourceRevision: 'r1',
      description: '原项目技能',
      source: 'skill',
      sourceInfo: { path: '/skills/local/SKILL.md', source: 'directory', scope: 'project', origin: 'top-level' },
    },
    {
      name: 'skill:local',
      resourceId: 'local-id',
      resourceRevision: 'r1',
      description: '项目内技能',
      source: 'skill',
      sourceInfo: { path: '/skills/local/SKILL.md', source: 'directory', scope: 'project', origin: 'top-level' },
    },
  ]
  const target: PiSlashCommand = {
    name: 'skill:shared',
    resourceId: 'shared-id',
    resourceRevision: 'r1',
    description: '目标技能',
    source: 'skill',
    sourceInfo: { path: '/skills/local/SKILL.md', source: 'directory', scope: 'project', origin: 'top-level' },
  }
  const attachments = [
    {
      id: 'image',
      type: 'image' as const,
      name: '截图',
      data: 'aGVsbG8=',
      mimeType: 'image/png' as const,
      preview: '',
    },
  ]
  const original = {
    draft: `${skillMarker} 检查 @src/app.ts ${skillMarker}`,
    selectedSkills: source,
    attachments,
    queueMode: 'followUp' as const,
  }
  const result = transferDraft(original, [target])
  assert.equal(result.composer.draft, `${skillMarker} 检查 @src/app.ts $local`)
  assert.deepEqual(result.composer.selectedSkills, [target])
  assert.equal(result.composer.selectedSkills[0], target)
  assert.equal(result.composer.attachments, attachments)
  assert.equal(result.composer.queueMode, 'followUp')
  assert.equal(result.removedSkills, true)
  assert.equal(original.draft, `${skillMarker} 检查 @src/app.ts ${skillMarker}`)
})

test('普通草稿原样保留，技能不能被同名普通命令替代', () => {
  const source: PiSlashCommand = {
    name: 'skill:local',
    resourceId: 'local-id',
    resourceRevision: 'r1',
    description: '',
    source: 'skill',
    sourceInfo: { path: '/skills/local/SKILL.md', source: 'directory', scope: 'project', origin: 'top-level' },
  }
  const result = transferDraft(
    { draft: skillMarker, selectedSkills: [source], attachments: [], queueMode: 'steering' },
    [{ ...source, source: 'extension' }],
  )
  assert.equal(result.composer.draft, '$local')
  assert.deepEqual(result.composer.selectedSkills, [])
  const plain = transferDraft({ draft: '普通文字', selectedSkills: [], attachments: [], queueMode: 'steering' }, [])
  assert.equal(plain.composer.draft, '普通文字')
  assert.equal(plain.removedSkills, false)
})

test('同名技能换Host或修订后不得替换已选择身份', () => {
  const original: PiSlashCommand = {
    name: 'skill:local',
    description: '',
    source: 'skill',
    resourceId: 'host-A',
    resourceRevision: 'r1',
    sourceInfo: { path: '/snapshots/r1/SKILL.md', source: 'host', scope: 'user', origin: 'top-level' },
  }
  for (const candidate of [
    { ...original, resourceId: 'host-B' },
    { ...original, resourceRevision: 'r2' },
  ]) {
    const result = transferDraft(
      { draft: skillMarker, selectedSkills: [original], attachments: [], queueMode: 'followUp' },
      [candidate],
    )
    assert.equal(result.composer.draft, '$local')
    assert.deepEqual(result.composer.selectedSkills, [])
    assert.equal(result.removedSkills, true)
  }
})
