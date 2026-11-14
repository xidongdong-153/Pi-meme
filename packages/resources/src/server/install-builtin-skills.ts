import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

async function copySkillDirectory(source: string, target: string) {
  await mkdir(target, { recursive: true })
  if ((await lstat(target)).isSymbolicLink()) throw new Error('内置技能安装目录不允许软链接')
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const input = path.join(source, entry.name)
    const output = path.join(target, entry.name)
    if (entry.isDirectory()) await copySkillDirectory(input, output)
    else if (entry.isFile()) {
      const mode = (await stat(input)).mode & 0o777
      const temporary = path.join(target, `.${entry.name}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, await readFile(input), { mode, flag: 'wx' })
        await chmod(temporary, mode)
        // 已安装资源可能是只读文件；替换目录项，避免原地覆盖失败或留下半写文件。
        await rename(temporary, output)
      } finally {
        await rm(temporary, { force: true })
      }
    }
  }
  // 此目录由应用管理；升级后同步移除旧版文件，不能把已裁剪的工具链文档继续留在安装副本中。
  const names = new Set(entries.map((entry) => entry.name))
  for (const entry of await readdir(target)) {
    if (!names.has(entry)) await rm(path.join(target, entry), { recursive: true, force: true })
  }
}

export async function installBuiltinSkills(source: string, target: string, dataRoot: string) {
  // dataRoot 是 Host 已锁定的数据目录；其下的安装路径逐层检查，不跟随旧目录中的别名。
  const relative = path.relative(path.resolve(dataRoot), path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('内置技能安装目录必须位于应用数据目录内')
  let directory = await realpath(dataRoot)
  for (const part of relative.split(path.sep)) {
    directory = path.join(directory, part)
    try {
      await mkdir(directory)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    }
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('内置技能安装目录必须为真实目录')
  }
  target = directory
  let entries
  try {
    entries = await readdir(source, { withFileTypes: true })
  } catch (cause) {
    throw new Error(`无法读取内置技能：${source}；${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
  const installed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skill = path.join(source, entry.name)
    try {
      await readFile(path.join(skill, 'SKILL.md'), 'utf8')
    } catch (cause) {
      if (entry.name !== 'skill-creator') continue
      throw new Error(
        `无法安装内置 Skill Creator：${skill}；${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
    await copySkillDirectory(skill, path.join(target, entry.name))
    installed.push(entry.name)
  }
  if (!installed.includes('skill-creator')) {
    throw new Error(`无法安装内置 Skill Creator：${path.join(source, 'skill-creator')}`)
  }
}
