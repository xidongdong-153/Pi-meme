import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 从实际安装目录收集许可；不依赖 pnpm 在 hoisted 布局下报告的虚拟包路径。 */
export async function writeThirdPartyLicenses(repo: string, output: string) {
  const visited = new Set<string>()
  const notices = new Map<string, string>()

  async function visitModules(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return []
      throw cause
    })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '@pi-meme') continue
      const target = path.join(directory, entry.name)
      if (entry.name.startsWith('@')) {
        await visitModules(target)
        continue
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const resolved = await realpath(target)
      if (visited.has(resolved)) continue
      visited.add(resolved)
      const manifest = JSON.parse(await readFile(path.join(resolved, 'package.json'), 'utf8')) as {
        name: string
        version: string
        license?: unknown
        author?: unknown
        homepage?: string
      }
      if (!manifest.name.startsWith('@pi-meme/') && manifest.name !== 'pi-meme') {
        const sections = [
          `${manifest.name}@${manifest.version}`,
          `许可声明：${JSON.stringify(manifest.license ?? '未在 package.json 声明')}`,
          `作者：${JSON.stringify(manifest.author ?? '')}`,
          `项目地址：${manifest.homepage ?? ''}`,
        ]
        for (const file of (await readdir(resolved, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (!/^(?:licen[cs]e|copying|notice|copyright)(?:[.\-_]|$)/i.test(file.name)) continue
          if (file.isFile())
            sections.push(`\n--- ${file.name} ---\n${await readFile(path.join(resolved, file.name), 'utf8')}`)
          else if (file.isDirectory()) {
            const directory = path.join(resolved, file.name)
            for (const nested of await readdir(directory, { recursive: true, withFileTypes: true })) {
              if (!nested.isFile()) continue
              const source = path.join(nested.parentPath, nested.name)
              sections.push(`\n--- ${path.relative(resolved, source)} ---\n${await readFile(source, 'utf8')}`)
            }
          }
        }
        notices.set(`${manifest.name}@${manifest.version}`, sections.join('\n'))
      }
      await visitModules(path.join(resolved, 'node_modules'))
    }
  }

  await visitModules(path.join(repo, 'node_modules'))
  const sections = [
    '第三方依赖许可集合，包含生产依赖和构建依赖。许可文本保持原文。',
    ...[...notices].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text),
  ]
  for (const source of ['packages/ui/src/components/react-bits.LICENSE.md', 'pi/skills/skill-creator/license.txt'])
    sections.push(`${source}\n\n${await readFile(path.join(repo, source), 'utf8')}`)
  await writeFile(output, `${sections.join('\n\n========================================\n\n')}\n`)
}
