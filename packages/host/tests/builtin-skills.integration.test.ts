import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import type { PiSlashCommand } from '@pi-meme/contracts/pi'
import { skillMarker } from '@pi-meme/contracts/skills'
import { MemoryCredentialStorage } from '@pi-meme/pi-runtime/secure-store'
import { expandSkills } from '@pi-meme/pi-runtime/skill-prompt'
import { createHost } from '../src/service'

test('无模型凭据首次启动自带 Skill Creator，用户同名技能不覆盖内置技能', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-builtin-skills-'))
  const userFile = path.join(root, 'skills', 'skill-creator', 'SKILL.md')
  const userContent = '---\nname: skill-creator\ndescription: 用户同名技能\n---\n\n用户正文。\n'
  await mkdir(path.dirname(userFile), { recursive: true })
  await writeFile(userFile, userContent)
  let host: Awaited<ReturnType<typeof createHost>> | undefined
  try {
    host = await createHost({ dataRoot: root, credentials: new MemoryCredentialStorage() })
    const response = await host.rpc({
      requestId: crypto.randomUUID(),
      clientId: 'skills',
      method: 'pi:commands',
      args: [],
    })
    assert.equal(response.error, undefined)
    const commands = response.result as PiSlashCommand[]
    const skills = commands.filter((command) => command.name === 'skill:skill-creator')
    assert.equal(skills.length, 1)
    assert.equal(skills[0].displayName, 'Skill Creator')
    assert.equal(skills[0].builtin, true)
    const pluginCreator = commands.find((command) => command.name === 'skill:plugin-creator')
    assert.equal(pluginCreator?.displayName, 'Plugin Creator')
    assert.equal(pluginCreator?.builtin, true)
    assert.equal(skills[0].sourceInfo.source, 'builtin')
    assert.ok(skills[0].sourceInfo.path.startsWith(path.join(root, 'resources', 'snapshots')))
    assert.ok(skills[0].resourceId && skills[0].resourceRevision)
    assert.equal(await readFile(userFile, 'utf8'), userContent)
    assert.ok((await readFile(skills[0].sourceInfo.path, 'utf8')).includes('name: skill-creator'))
    const expanded = await expandSkills(
      skillMarker,
      [{ name: skills[0].name, id: skills[0].resourceId!, revision: skills[0].resourceRevision! }],
      commands,
    )
    assert.match(expanded, /<skill name="skill-creator"/)
    assert.ok(expanded.includes(skills[0].sourceInfo.path))
    assert.doesNotMatch(expanded, /用户正文/)
  } finally {
    await host?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('再次启动更新内置技能，保留用户技能文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-meme-builtin-skill-update-'))
  const source = path.join(root, 'application-skills')
  const sourceFile = path.join(source, 'skill-creator', 'SKILL.md')
  const userFile = path.join(root, 'data', 'skills', 'custom', 'SKILL.md')
  await mkdir(path.dirname(sourceFile), { recursive: true })
  await mkdir(path.dirname(userFile), { recursive: true })
  await writeFile(userFile, '用户技能')
  const options = {
    dataRoot: path.join(root, 'data'),
    builtinSkillsSource: source,
    credentials: new MemoryCredentialStorage(),
  }
  let host: Awaited<ReturnType<typeof createHost>> | undefined
  try {
    for (const revision of ['首版', '更新版']) {
      await writeFile(sourceFile, `---\nname: skill-creator\ndescription: ${revision}\n---\n\n${revision}\n`)
      host = await createHost(options)
      assert.match(
        await readFile(path.join(options.dataRoot, 'builtin-resources', 'skills', 'skill-creator', 'SKILL.md'), 'utf8'),
        new RegExp(revision),
      )
      await host.dispose()
      host = undefined
    }
    assert.equal(await readFile(userFile, 'utf8'), '用户技能')
  } finally {
    await host?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
