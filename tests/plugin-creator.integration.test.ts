import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  appendFile,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, test } from 'vitest'
import { PluginManager } from '../packages/plugin-runtime/src/manager'
import {
  materializeResource,
  readResourceFiles,
  resourceSizeLimit,
} from '../packages/resources/src/server/resource-files'
import { installBuiltinSkills } from '../packages/resources/src/server/install-builtin-skills'
import { toolchainDirectory } from '../packages/plugin-devkit/src/toolchain'
import { createPlugin } from '../packages/plugin-devkit/src/create'
import { checkPlugin } from '../packages/plugin-devkit/src/check'
import { parseTheme } from '../packages/settings/src/shared/themes'
import { copyBuiltinSkillsPlugin } from '../scripts/copy-builtin-skills.mjs'

let tools: string
beforeAll(async () => {
  tools = await toolchainDirectory()
}, 30000)

test('源码检查支持 rootDir 与未使用声明检查', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-plugin-strict-'))
  try {
    const directory = path.join(root, 'plugin')
    await createPlugin(directory, 'strict-fixture', { agent: 'restricted' })
    const file = path.join(directory, 'tsconfig.json')
    const config = JSON.parse(await readFile(file, 'utf8'))
    Object.assign(config.compilerOptions, { rootDir: 'src', noUnusedLocals: true, noUnusedParameters: true })
    await writeFile(file, JSON.stringify(config))
    await checkPlugin(directory)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('源码检查不会被项目的 noCheck 配置跳过', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-plugin-no-check-'))
  try {
    const directory = path.join(root, 'plugin')
    await createPlugin(directory, 'no-check-fixture', { agent: 'restricted' })
    const file = path.join(directory, 'tsconfig.json')
    const config = JSON.parse(await readFile(file, 'utf8'))
    config.compilerOptions.noCheck = true
    await writeFile(file, JSON.stringify(config))
    await appendFile(path.join(directory, 'src/agent/restricted.ts'), "\nconst value: number = 'wrong'\n")
    await assert.rejects(checkPlugin(directory), /类型检查失败/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('生成工程的依赖声明和开发工具目录通过包边界检查', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-plugin-boundaries-'))
  try {
    await createPlugin(path.join(root, 'plugins/probe'), 'boundary-fixture', { agent: 'restricted', ui: 'panel' })
    await mkdir(path.join(root, 'scripts'))
    const script = path.join(root, 'scripts/check-package-boundaries.mjs')
    await writeFile(
      script,
      await readFile(path.resolve(import.meta.dirname, '../scripts/check-package-boundaries.mjs')),
    )
    await mkdir(path.join(root, 'node_modules'))
    await symlink(path.join(tools, 'node_modules/typescript'), path.join(root, 'node_modules/typescript'), 'dir')
    const result = await command(script, [], root)
    assert.match(result.stdout, /包依赖检查通过/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function command(entry: string, args: string[], cwd: string) {
  const env = { ...process.env }
  delete env.NODE_PATH
  delete env.ESBUILD_BINARY_PATH
  return promisify(execFile)(process.execPath, [entry, ...args], { cwd, env, maxBuffer: 2 * 1024 * 1024 })
}

const templates = [
  { name: 'restricted', flags: ['--agent', 'restricted', '--server', 'restricted'] },
  { name: 'trusted', flags: ['--agent', 'trusted', '--server', 'trusted', '--ui', 'page'] },
  { name: 'mixed', flags: ['--agent', 'both', '--server', 'both', '--ui', 'panel'] },
  { name: 'panel', flags: ['--ui', 'panel'] },
  { name: 'theme', flags: ['--resources', 'themes,assets'] },
  { name: 'skills', flags: ['--resources', 'skills'] },
]
for (const fixture of templates) {
  test(`仓库外离线创建 ${fixture.name}，检查、构建、打包并安装`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pi-plugin-creator-'))
    const directory = path.join(root, 'plugin')
    const manager = new PluginManager({
      directory: path.join(root, 'installed'),
      dataDirectory: path.join(root, 'data'),
      stateFile: path.join(root, 'state/plugins.json'),
    })
    try {
      const entry = path.join(tools, 'cli.mjs')
      await command(entry, ['doctor'], root)
      await command(entry, ['create', directory, fixture.name, '--display-name', '测试插件', ...fixture.flags], root)
      assert.equal((await readdir(directory)).includes('node_modules'), false)
      const moved = path.join(root, 'moved')
      await rename(directory, moved)
      const localEntry = path.join(moved, '.pi-meme-devkit/cli.mjs')
      await command(localEntry, ['check', '.'], moved)
      await command(localEntry, ['build', '.'], moved)
      await command(localEntry, ['validate', '.'], moved)
      const output = path.join(root, 'plugin.pim')
      await command(localEntry, ['pack', '.', output], moved)
      const descriptor = await manager.installPackage(await readFile(output))
      assert.equal(descriptor.id, fixture.name)
      assert.equal(descriptor.display?.name, '测试插件')
      const installed = await readdir(descriptor.directory)
      assert.equal(installed.includes('.pi-meme-devkit'), false)
      assert.equal(installed.includes('node_modules'), false)
      assert.equal(installed.includes('src'), false)
      if (fixture.name === 'trusted' || fixture.name === 'mixed') {
        await manager.setGrant(descriptor.id, {
          ...descriptor.grant!,
          expectedRevision: descriptor.grant!.revision,
          policyHash: descriptor.policyHash!,
          trusted: { ui: true, agent: true, server: true },
        })
        const active = manager.list().find((item) => item.id === descriptor.id)!
        const requestId = crypto.randomUUID()
        const result = await manager.callUi(
          'fixture',
          {
            pluginId: active.id,
            generation: active.generation,
            policyHash: active.policyHash!,
            operation: 'time',
            input: {},
            requestId,
          },
          {
            pluginId: active.id,
            generation: active.generation,
            origin: 'ui',
            target: { hostId: 'fixture' },
            mode: 'default',
            accessMode: 'full-access',
            capabilities: [],
            signal: new AbortController().signal,
            requestId,
          },
        )
        assert.match(String(result), /^\d{4}-\d{2}-\d{2}T/)
      }
      if (fixture.name === 'skills')
        assert.match(await readFile(path.join(descriptor.directory, 'skills/skills/SKILL.md'), 'utf8'), /name: skills/)
      if (fixture.name === 'theme')
        assert.equal(
          parseTheme(JSON.parse(await readFile(path.join(descriptor.directory, 'themes/custom.json'), 'utf8'))).id,
          'custom',
        )
    } finally {
      await manager.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
}

test('内置技能复制和快照保留工具、执行权限与大小边界，可直接生成插件', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-plugin-skill-'))
  try {
    const source = path.join(root, 'source/skills')
    const copySkills = copyBuiltinSkillsPlugin()
    copySkills.configResolved({ root, build: { outDir: 'source' } })
    await copySkills.closeBundle()
    const builtin = path.join(root, 'builtin')
    await installBuiltinSkills(source, builtin)
    const files = await readResourceFiles(path.join(builtin, 'plugin-creator'))
    assert.ok(files.reduce((size, file) => size + file.content.length, 0) < resourceSizeLimit)
    const snapshot = await materializeResource(path.join(root, 'snapshots'), files)
    await rm(source, { recursive: true })
    await rm(builtin, { recursive: true })
    await access(
      path.join(snapshot, `dist/toolchain/node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`),
      constants.X_OK,
    )
    const entry = path.join(snapshot, 'scripts/plugin.mjs')
    await command(entry, ['doctor'], root)
    const directory = path.join(root, 'plugin')
    await command(entry, ['create', directory, 'snapshot-tool', '--agent', 'restricted'], root)
    await rm(snapshot, { recursive: true })
    const localEntry = path.join(directory, '.pi-meme-devkit/cli.mjs')
    for (const action of ['check', 'build', 'validate']) await command(localEntry, [action, '.'], directory)
    await command(localEntry, ['pack', '.', path.join(root, 'snapshot.pim')], directory)
    assert.ok((await readFile(path.join(root, 'snapshot.pim'))).length > 0)
    const sourceFile = path.join(directory, 'src/agent/restricted.ts')
    const sourceContent = await readFile(sourceFile, 'utf8')
    await rm(path.join(directory, '.pi-meme-devkit/dist'), { recursive: true })
    await command(path.join(tools, 'cli.mjs'), ['prepare', directory], root)
    assert.equal(await readFile(sourceFile, 'utf8'), sourceContent)
    await command(localEntry, ['check', '.'], directory)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test('拒绝覆盖、非法声明、缺失资源、错误导出、类型错误和 UI Node 导入', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-plugin-invalid-'))
  try {
    const entry = path.join(tools, 'cli.mjs')
    const directory = path.join(root, 'plugin')
    await mkdir(directory)
    await writeFile(path.join(directory, 'keep.txt'), '保留用户文件')
    await assert.rejects(command(entry, ['create', directory, 'keep', '--ui', 'panel'], root), /exist|EEXIST/)
    assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), '保留用户文件')
    await assert.rejects(command(entry, ['create', path.join(root, 'invalid'), 'Invalid'], root), /npm/)
    await assert.rejects(command(entry, ['create', path.join(root, 'reserved'), '@pi-meme/chat'], root), /内置模块/)
    await rm(directory, { recursive: true })
    await command(
      entry,
      ['create', directory, 'invalid-fixture', '--ui', 'panel', '--resources', 'assets,skills'],
      root,
    )
    const local = path.join(directory, '.pi-meme-devkit/cli.mjs')
    const source = path.join(directory, 'src/ui/entry.tsx')
    const original = await readFile(source, 'utf8')
    await writeFile(source, 'export const wrong = true\n')
    await assert.rejects(command(local, ['check', '.'], directory), /activate/)
    await writeFile(source, `const value: number = 'wrong'\n${original}`)
    await assert.rejects(command(local, ['check', '.'], directory), /类型检查失败/)
    await writeFile(source, `import fs from 'node:fs'\nconsole.log(fs)\n${original}`)
    await assert.rejects(command(local, ['check', '.'], directory), /node:fs/)
    await writeFile(source, original)
    await rm(source)
    await assert.rejects(command(local, ['check', '.'], directory), /entry.tsx/)
    await writeFile(source, original)
    await rm(path.join(directory, 'assets'), { recursive: true })
    await assert.rejects(command(local, ['check', '.'], directory), /assets/)
    await mkdir(path.join(directory, 'assets'))
    await writeFile(path.join(directory, 'assets/icon.svg'), '<svg/>')
    const skill = path.join(directory, 'skills/invalid-fixture/SKILL.md')
    const skillContent = await readFile(skill, 'utf8')
    await writeFile(skill, '缺少 frontmatter')
    await assert.rejects(command(local, ['check', '.'], directory), /技能检查失败/)
    await writeFile(skill, skillContent)
    const manifestFile = path.join(directory, 'package.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    manifest.piMeme.resources.assets = ['../outside']
    await writeFile(manifestFile, JSON.stringify(manifest))
    await assert.rejects(command(local, ['check', '.'], directory), /相对路径/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test('可信构建保留 SDK 运行时辅助函数，产物篡改后拒绝校验与打包', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-plugin-tamper-'))
  try {
    const directory = path.join(root, 'plugin')
    await command(path.join(tools, 'cli.mjs'), ['create', directory, 'tamper', '--server', 'trusted'], root)
    const source = path.join(directory, 'src/server/entry.ts')
    await writeFile(
      source,
      `import { defineServerOperation } from '@pi-meme/plugin-sdk/server'\nconsole.log(typeof defineServerOperation)\n${await readFile(source, 'utf8')}`,
    )
    const entry = path.join(directory, '.pi-meme-devkit/cli.mjs')
    await command(entry, ['check', '.'], directory)
    await command(entry, ['build', '.'], directory)
    const manifest = JSON.parse(await readFile(path.join(directory, 'dist/server/chord-facets.json'), 'utf8'))
    await appendFile(path.join(directory, 'dist/server', manifest.entries.server.file), '\n// 篡改产物\n')
    await assert.rejects(command(entry, ['validate', '.'], directory), /integrity|hash|sha256|校验/i)
    await assert.rejects(
      command(entry, ['pack', '.', path.join(root, 'invalid.pim')], directory),
      /integrity|hash|sha256|校验/i,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
