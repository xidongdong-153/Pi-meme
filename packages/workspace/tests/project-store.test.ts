import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectStore } from '../src/server/project-store'

test('登记项目重启后保留，符号链接去重，同名目录分别展示', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-projects-'))
  try {
    const first = path.join(directory, 'a', 'project')
    const second = path.join(directory, 'b', 'project')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    const alias = path.join(directory, 'alias')
    await symlink(first, alias)
    const store = new ProjectStore(directory)
    await store.load()
    const registered = await store.register(first)
    assert.equal((await store.register(alias)).cwd, registered.cwd)
    await store.register(second)
    const restored = new ProjectStore(directory)
    await restored.load()
    const projects = await restored.list()
    assert.equal(projects.length, 2)
    assert.deepEqual(
      projects.map((project) => project.name),
      ['project', 'project'],
    )
    assert.notEqual(projects[0].cwd, projects[1].cwd)
    await rm(second, { recursive: true })
    assert.equal((await restored.list()).find((project) => project.cwd.endsWith('/b/project'))?.unavailable, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('无项目目录独立且持久，不进入项目列表，也不能通过符号链接登记', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-standalone-'))
  try {
    const store = new ProjectStore(directory)
    await store.load()
    const first = await store.createStandaloneDirectory()
    const second = await store.createStandaloneDirectory()
    assert.notEqual(first, second)
    assert.equal(store.kind(first), 'standalone')
    assert.equal(store.isStandaloneDirectory(first), true)
    assert.equal(store.isStandaloneDirectory(path.dirname(first)), false)
    assert.equal(store.isStandaloneDirectory(path.join(first, 'child')), false)
    assert.equal(store.kind(`${first}-other/../outside`), 'standalone')
    assert.equal(store.kind(path.join(directory, 'standalone-workspaces-other', 'project')), 'project')
    const alias = path.join(directory, 'alias')
    await symlink(first, alias)
    await assert.rejects(store.register(alias), /不能将无项目会话目录登记为项目/)
    assert.deepEqual(await store.list([first, second]), [])
    const restored = new ProjectStore(directory)
    await restored.load()
    assert.equal(restored.kind(first), 'standalone')
    assert.equal(await restored.validateDirectory(first), first)
    await rm(first, { recursive: true })
    await assert.rejects(restored.validateDirectory(first), /目录不可用/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('损坏项目文件拒绝覆盖，目录无效和保存失败不改变登记内容', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-project-errors-'))
  try {
    const project = path.join(directory, 'project')
    await mkdir(project)
    const file = path.join(directory, 'projects.json')
    await writeFile(file, '{损坏')
    const store = new ProjectStore(directory)
    await store.load()
    await assert.rejects(store.list(), /无法读取项目文件/)
    await assert.rejects(store.register(project), /无法读取项目文件/)
    assert.equal(await readFile(file, 'utf8'), '{损坏')
    await rm(file)
    const valid = new ProjectStore(directory)
    await valid.load()
    await assert.rejects(valid.register('relative'), /绝对路径/)
    await assert.rejects(valid.register(path.join(directory, 'missing')), /目录不可用/)
    await writeFile(file, '普通文件')
    await assert.rejects(valid.register(file), /不是文件夹/)
    await mkdir(`${file}.tmp`)
    await assert.rejects(valid.register(project), /无法保存项目文件/)
    assert.deepEqual(await valid.list(), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
