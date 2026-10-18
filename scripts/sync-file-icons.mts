import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { format, resolveConfig } from 'prettier'

// 更新时修改固定提交，再运行 pnpm exec tsx scripts/sync-file-icons.mts。
const commit = 'b6915da9f6889b683a110aa747de96c2820a537d'
const repo = fileURLToPath(new URL('..', import.meta.url))
const assets = path.join(repo, 'packages/assets')
const sourceUrl = `https://github.com/catppuccin/vscode-icons/tree/${commit}`
const temporary = await mkdtemp(path.join(tmpdir(), 'pi-meme-file-icons-'))
const prettier = await resolveConfig(path.join(repo, 'package.json'))

function associations(source: string, variable: string, field: string, prefix = '') {
  const file = ts.createSourceFile('icons.ts', source, ts.ScriptTarget.Latest, true)
  const result: Record<string, string> = {}
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(file) !== variable || !declaration.initializer) continue
      if (!ts.isObjectLiteralExpression(declaration.initializer)) throw new Error('图标映射不是对象。')
      for (const icon of declaration.initializer.properties) {
        if (!ts.isPropertyAssignment(icon) || !ts.isObjectLiteralExpression(icon.initializer)) continue
        const iconName = icon.name.getText(file).replace(/^['"]|['"]$/g, '')
        for (const property of icon.initializer.properties) {
          if (!ts.isPropertyAssignment(property) || property.name.getText(file) !== field) continue
          if (!ts.isArrayLiteralExpression(property.initializer)) throw new Error('图标映射不是数组。')
          for (const name of property.initializer.elements) {
            if (!ts.isStringLiteral(name)) throw new Error('图标映射包含非字符串。')
            result[name.text.toLowerCase()] = prefix + iconName
          }
        }
      }
    }
  }
  if (!Object.keys(result).length) throw new Error(`未找到图标映射：${variable}.${field}`)
  return result
}

try {
  const response = await fetch(`https://codeload.github.com/catppuccin/vscode-icons/tar.gz/${commit}`)
  if (!response.ok) throw new Error(`下载图标失败：HTTP ${response.status}`)
  const archive = path.join(temporary, 'source.tar.gz')
  await writeFile(archive, new Uint8Array(await response.arrayBuffer()))
  await promisify(execFile)('tar', ['-xzf', archive, '-C', temporary])
  const source = path.join(temporary, `vscode-icons-${commit}`)
  const files = await readFile(path.join(source, 'src/defaults/fileIcons.ts'), 'utf8')
  const folders = await readFile(path.join(source, 'src/defaults/folderIcons.ts'), 'utf8')
  const names = (await readdir(path.join(source, 'icons/css-variables'))).filter((name) => name.endsWith('.svg')).sort()
  const symbols: string[] = []
  const colors = new Map<string, { light: string; dark: string }>()
  for (const name of names) {
    const [svg, light, dark] = await Promise.all(
      ['css-variables', 'latte', 'mocha'].map((flavor) => readFile(path.join(source, 'icons', flavor, name), 'utf8')),
    )
    const variables = [...svg.matchAll(/var\(--vscode-ctp-(\w+)\)/g)]
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let offset = 0
    let pattern = '^'
    for (const match of variables) {
      pattern += `${escape(svg.slice(offset, match.index))}(#[\\da-f]{6})`
      offset = match.index + match[0].length
    }
    const expression = new RegExp(`${pattern}${escape(svg.slice(offset))}$`, 'i')
    const lightColors = expression.exec(light)
    const darkColors = expression.exec(dark)
    if (!lightColors || !darkColors) throw new Error(`图标调色板不匹配：${name}`)
    variables.forEach((match, index) => {
      colors.set(match[1], { light: lightColors[index + 1], dark: darkColors[index + 1] })
    })
    const icon = path.basename(name, '.svg')
    const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1]
    if (!viewBox) throw new Error(`图标缺少 viewBox：${name}`)
    const content = svg
      .replace(/^[\s\S]*?<svg\b[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
      .replaceAll('--vscode-ctp-', '--file-icon-')
      .replace(/\bid="([^"]+)"/g, `id="${icon}-$1"`)
      .replace(/url\(#([^)]+)\)/g, `url(#${icon}-$1)`)
    symbols.push(`<symbol id="${icon}" viewBox="${viewBox}">${content}</symbol>`)
  }
  const iconNames = new Set(names.map((name) => path.basename(name, '.svg')))
  const maps = {
    fileNameIcons: associations(files, 'fileIcons', 'fileNames'),
    fileExtensionIcons: associations(files, 'fileIcons', 'fileExtensions'),
    folderNameIcons: associations(folders, 'folderIcons', 'folderNames', 'folder_'),
  }
  for (const icon of Object.values(maps).flatMap(Object.values)) {
    if (!iconNames.has(icon)) throw new Error(`图标映射指向不存在的图标：${icon}`)
  }
  const destination = path.join(assets, 'files/file-icons')
  await mkdir(destination, { recursive: true })
  await writeFile(
    path.join(destination, 'catppuccin.svg'),
    await format(`<svg xmlns="http://www.w3.org/2000/svg"><!-- ${sourceUrl} -->${symbols.join('\n')}</svg>`, {
      ...prettier,
      parser: 'html',
    }),
  )
  const generated = `// 由 scripts/sync-file-icons.mts 生成，来源：${sourceUrl}\n${Object.entries(maps)
    .map(([name, values]) => `export const ${name}: Record<string, string> = ${JSON.stringify(values)}`)
    .join('\n')}`
  await writeFile(
    path.join(assets, 'src/file-icon-data.ts'),
    await format(generated, { ...prettier, parser: 'typescript' }),
  )
  const css = `.pi-file-icon {\n${[...colors]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `--file-icon-${name}: light-dark(${value.light}, ${value.dark});`)
    .join('\n')}\n}`
  await writeFile(path.join(assets, 'src/file-icons.css'), await format(css, { ...prettier, parser: 'css' }))
  await writeFile(path.join(destination, 'LICENSE'), await readFile(path.join(source, 'LICENSE')))
  console.log(`已同步 ${names.length} 个 Catppuccin 图标，提交：${commit}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
