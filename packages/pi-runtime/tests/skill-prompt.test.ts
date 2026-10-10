import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import { expandSkills } from '../src/skill-prompt'
import { message } from '@pi-meme/contracts/ipc'

const commands: PiSlashCommand[] = ['typescript', 'review-code'].map((name) => ({
  name: `skill:${name}`,
  source: 'skill',
  sourceInfo: {
    path: fileURLToPath(new URL(`../../../tests/fixtures/skills/${name}/SKILL.md`, import.meta.url)),
    scope: 'user',
    source: 'test',
    origin: 'top-level',
  },
}))

test('多个技能按正文位置展开，保留前后文字和换行', async () => {
  const draft = `123 ${skillMarker} 与 ${skillMarker}\n看看技能`
  const expanded = await expandSkills(
    draft,
    commands.map(({ name }) => ({ name })),
    commands,
  )
  assert.match(expanded, /检查 TypeScript 类型/)
  assert.match(expanded, /检查代码改动/)
  assert.doesNotMatch(expanded, /description:|\uFFFC/)
  assert.match(expanded, /^123 <skill name="typescript"/)
  assert.match(expanded, / 与 <skill name="review-code"/)
  assert.match(expanded, /<\/skill>\n看看技能$/)
  assert.equal((expanded.match(/<\/skill>/g) ?? []).length, 2)
})

test('重复技能标记各自展开为独立技能块', async () => {
  const expanded = await expandSkills(
    `${skillMarker} ${skillMarker}`,
    [{ name: 'skill:typescript' }, { name: 'skill:typescript' }],
    commands,
  )
  assert.equal((expanded.match(/<skill name="typescript"/g) ?? []).length, 2)
})

test('主进程拒绝未加载技能、标记数量错误和无效 IPC 参数', async () => {
  await assert.rejects(expandSkills(skillMarker, [{ name: 'skill:missing' }], commands), /技能已不可用/)
  await assert.rejects(expandSkills('正文', [{ name: 'skill:typescript' }], commands), /数量不一致/)
  assert.throws(() => message(skillMarker, undefined, [{ name: 'read', path: '/etc/passwd' }]), /技能参数无效/)
  const missingFile = [
    { ...commands[0], sourceInfo: { ...commands[0].sourceInfo, path: '/not-a-real-skill/SKILL.md' } },
  ]
  await assert.rejects(expandSkills(skillMarker, [{ name: 'skill:typescript' }], missingFile), /读取技能失败/)
})
