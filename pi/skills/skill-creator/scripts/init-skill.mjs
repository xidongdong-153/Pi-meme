#!/usr/bin/env node
// 改编自 OpenAI Codex skill-creator 初始化脚本；使用 Node.js 标准库，不生成 Codex 专有配置。
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      path: { type: 'string' },
      resources: { type: 'string', default: '' },
    },
  })
  const [name] = positionals
  if (positionals.length !== 1 || !values.path) {
    throw new Error('用法：node init-skill.mjs <skill-name> --path <输出目录> [--resources scripts,references,assets]')
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error('技能名称须为 1 至 64 个字符，只能使用小写字母、数字和分隔词语的连字符')
  }
  const resources = [
    ...new Set(
      values.resources
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
  const allowed = new Set(['scripts', 'references', 'assets'])
  if (resources.some((resource) => !allowed.has(resource))) {
    throw new Error('--resources 只接受 scripts、references、assets，以逗号分隔')
  }
  const outputDir = path.resolve(values.path)
  if (outputDir.split(path.sep).some((part) => part === '.pi' || part === 'builtin-skills')) {
    throw new Error('不能在项目 .pi 或应用 builtin-skills 目录内生成技能，请选择已授权的工作区输出目录')
  }
  let existingParent = outputDir
  let actualOutputDir
  while (!actualOutputDir) {
    try {
      actualOutputDir = path.resolve(await realpath(existingParent), path.relative(existingParent, outputDir))
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
      const parent = path.dirname(existingParent)
      if (parent === existingParent) {
        throw error
      }
      existingParent = parent
    }
  }
  if (actualOutputDir.split(path.sep).some((part) => part === '.pi' || part === 'builtin-skills')) {
    throw new Error('输出目录实际指向项目 .pi 或应用 builtin-skills，请选择已授权的工作区输出目录')
  }
  await mkdir(actualOutputDir, { recursive: true })
  const skillDir = path.join(actualOutputDir, name)
  await mkdir(skillDir)
  const title = name
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
  const content = `---
name: ${name}
description: "[TODO: 写明技能适用的任务与触发场景。]"
---

# ${title}

[TODO: 写明当前任务所需的指令、执行边界和参考文件。]
`
  await writeFile(path.join(skillDir, 'SKILL.md'), content, { encoding: 'utf8', flag: 'wx' })
  for (const resource of resources) {
    await mkdir(path.join(skillDir, resource))
  }
  console.log(`已创建技能：${skillDir}`)
  console.log('完成 SKILL.md 中的 TODO，按需添加资源文件，再运行 quick-validate.mjs。当前结果尚未安装。')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
    console.error('创建失败：目标技能目录或文件已存在，没有覆盖。更新已有技能时直接编辑原文件。')
  } else {
    console.error(`创建失败：${message}`)
  }
  process.exitCode = 1
}
