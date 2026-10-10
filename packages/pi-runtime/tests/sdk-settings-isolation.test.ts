import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDesktopSettingsManager } from '../src/sdk/settings'
import { loadPiSdk } from '../src/sdk/load'

test('项目 .pi 设置只读，项目扩展路径受限，项目 packages 不安装', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-settings-isolation-'))
  const cwd = path.join(directory, 'project')
  const agentDir = path.join(directory, 'userData', 'pi')
  const projectPi = path.join(cwd, '.pi')
  const extension = path.join(projectPi, 'extensions', 'project.mjs')
  const outside = path.join(directory, 'external.mjs')
  const globalSettingsPath = path.join(agentDir, 'settings.json')
  const projectSettingsPath = path.join(projectPi, 'settings.json')
  await mkdir(path.dirname(extension), { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    globalSettingsPath,
    JSON.stringify({ defaultProvider: 'desktop-provider', packages: ['desktop-package'] }),
  )
  await writeFile(
    projectSettingsPath,
    JSON.stringify({
      defaultProvider: 'project-provider',
      extensions: [extension, outside],
      packages: ['project-package'],
    }),
  )
  const originalProjectSettings = await readFile(projectSettingsPath, 'utf8')
  try {
    const sdk = await loadPiSdk()
    const manager = createDesktopSettingsManager(sdk, cwd, agentDir)
    assert.equal(manager.getDefaultProvider(), 'project-provider')
    assert.deepEqual(manager.getExtensionPaths(), [extension])
    assert.deepEqual(manager.getPackages(), ['desktop-package'])
    assert.equal(manager.getProjectSettings().packages, undefined)

    manager.setDefaultModelAndProvider('desktop-updated', 'desktop-model')
    manager.setProjectExtensionPaths([outside])
    await manager.flush()

    assert.equal(await readFile(projectSettingsPath, 'utf8'), originalProjectSettings)
    const globalSettings = JSON.parse(await readFile(globalSettingsPath, 'utf8'))
    assert.equal(globalSettings.defaultProvider, 'desktop-updated')
    assert.equal(globalSettings.defaultModel, 'desktop-model')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('只加载 Desktop 与项目 .pi 技能，不加载 HOME 下的 .agents 技能或项目 packages', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-skill-isolation-'))
  const cwd = path.join(directory, 'project')
  const projectPi = path.join(cwd, '.pi')
  const agentDir = path.join(directory, 'userData', 'pi')
  const homeDirectory = path.join(directory, 'home')
  const skillFile = (root: string, name: string) => path.join(root, name, 'SKILL.md')
  const desktopSkill = skillFile(path.join(agentDir, 'skills'), 'desktop-only')
  const projectSkill = skillFile(path.join(projectPi, 'skills'), 'project-only')
  const hostSkill = skillFile(path.join(homeDirectory, '.agents', 'skills'), 'host-only')
  const projectSettingsPath = path.join(projectPi, 'settings.json')
  const originalHome = process.env.HOME
  await Promise.all(
    [desktopSkill, projectSkill, hostSkill].map((file) => mkdir(path.dirname(file), { recursive: true })),
  )
  await mkdir(agentDir, { recursive: true })
  await writeFile(desktopSkill, '---\nname: desktop-only\ndescription: Desktop skill\n---\n\nDesktop skill.\n')
  await writeFile(projectSkill, '---\nname: project-only\ndescription: Project skill\n---\n\nProject skill.\n')
  await writeFile(hostSkill, '---\nname: host-only\ndescription: Host skill\n---\n\nHost skill.\n')
  await writeFile(projectSettingsPath, JSON.stringify({ packages: ['project-package'] }))
  try {
    process.env.HOME = homeDirectory
    const sdk = await loadPiSdk()
    const settingsManager = createDesktopSettingsManager(sdk, cwd, agentDir)
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        noSkills: true,
        additionalSkillPaths: [path.join(agentDir, 'skills'), path.join(projectPi, 'skills')],
      },
    })

    assert.deepEqual(
      services.resourceLoader
        .getSkills()
        .skills.map((skill) => skill.name)
        .sort(),
      ['desktop-only', 'project-only'],
    )
    assert.equal(await readFile(projectSettingsPath, 'utf8'), JSON.stringify({ packages: ['project-package'] }))
    assert.deepEqual(settingsManager.getProjectSettings().packages, undefined)
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    await rm(directory, { recursive: true, force: true })
  }
})
