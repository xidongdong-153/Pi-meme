#!/usr/bin/env node
// 改编自 OpenAI Codex skill-creator 基础校验脚本；检查名称、描述与占位符，不解析完整 YAML。
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function readString(frontmatter, key) {
  const lines = frontmatter.split('\n')
  const matches = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith(`${key}:`))
  if (matches.length !== 1) {
    throw new Error(`frontmatter 必须包含且仅包含一个 ${key} 字段`)
  }
  const { line, index } = matches[0]
  const value = line.slice(key.length + 1).trim()
  if (/^[|>][-+]?$/.test(value)) {
    const block = []
    for (let next = index + 1; next < lines.length && (/^\s/.test(lines[next]) || !lines[next]); next++) {
      block.push(lines[next].trim())
    }
    return block.join(value[0] === '>' ? ' ' : '\n').trim()
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'string') {
        return parsed
      }
    } catch {
      throw new Error(`${key} 的双引号字符串格式不正确；该脚本支持 JSON 兼容的双引号写法`)
    }
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) {
      throw new Error(`${key} 的单引号字符串格式不正确`)
    }
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (!value || /^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/i.test(value) || /^[[{&*!]/.test(value)) {
    throw new Error(`${key} 必须是非空字符串；特殊值须加引号`)
  }
  if (value.includes(': ') || /\s#/.test(value)) {
    throw new Error(`${key} 包含 YAML 分隔符，请使用引号包住整个值`)
  }
  return value
}

try {
  if (process.argv.length !== 3) {
    throw new Error('用法：node quick-validate.mjs <技能目录>')
  }
  const skillDir = path.resolve(process.argv[2])
  const content = (await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).replaceAll('\r\n', '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content)
  if (!match) {
    throw new Error('SKILL.md 必须以完整的 YAML frontmatter 开头')
  }
  const name = readString(match[1], 'name')
  const description = readString(match[1], 'description')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error('name 须为 1 至 64 个字符，只能使用小写字母、数字和分隔词语的连字符')
  }
  if (path.basename(skillDir) !== name) {
    throw new Error('技能目录名称与 frontmatter 的 name 不一致')
  }
  if (!description.trim() || description.length > 1024 || /[<>]/.test(description)) {
    throw new Error('description 须为 1 至 1024 个字符，且不能包含尖括号')
  }
  if (/^\[TODO:/i.test(description)) {
    throw new Error('description 包含未完成的 TODO 占位符')
  }
  const body = content.slice(match[0].length)
  if (!body.trim()) {
    throw new Error('SKILL.md 缺少技能指令正文')
  }
  let fence
  for (const line of body.split('\n')) {
    const marker = /^\s*(?:[-+*]\s+|\d+[.)]\s+)?(`{3,}(?!`)|~{3,}(?!~))(.*)$/.exec(line)
    if (marker) {
      if (!fence) {
        fence = marker[1]
      } else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined
      }
    } else if (!fence && /^\s*\[TODO:.*\]\s*$/i.test(line)) {
      throw new Error('技能正文包含未完成的 TODO 占位符')
    }
  }
  console.log(`基础检查通过：${name}。仍需核查完整 YAML、引用文件和实际执行行为。`)
} catch (error) {
  console.error(`检查失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
