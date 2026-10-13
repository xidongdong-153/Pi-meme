import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Theme } from '@pi-meme/contracts/settings'
import { parseTheme } from '../shared/themes'

export type ThemePackage = {
  id: string
  generation: number
  directory: string
  enabled: boolean
  resources?: { themes?: string[]; assets?: string[] }
}

async function packageFile(directory: string, relative: string) {
  const root = await realpath(directory)
  const target = await realpath(path.resolve(root, relative))
  if (!target.startsWith(`${root}${path.sep}`) || !(await stat(target)).isFile())
    throw new Error(`主题文件必须位于插件包内：${relative}`)
  return target
}

export async function loadPluginThemes(
  packages: ThemePackage[],
  assetUrl: (plugin: ThemePackage, relative: string) => string,
): Promise<Theme[]> {
  const themes: Theme[] = []
  for (const plugin of packages.filter((entry) => entry.enabled)) {
    for (const relative of plugin.resources?.themes ?? []) {
      const filename = await packageFile(plugin.directory, relative)
      if ((await stat(filename)).size > 256 * 1024) throw new Error(`主题 JSON 超过 256 KiB：${relative}`)
      const theme = parseTheme(JSON.parse(await readFile(filename, 'utf8')))
      if (theme.background) {
        const image = theme.background.image
        if (!plugin.resources?.assets?.some((entry) => image === entry || image.startsWith(`${entry}/`)))
          throw new Error(`主题背景未在插件 assets 中声明：${image}`)
        const filename = await packageFile(plugin.directory, image)
        if ((await stat(filename)).size > 8 * 1024 * 1024) throw new Error(`主题图片超过 8 MiB：${image}`)
        theme.background.url = assetUrl(plugin, image)
      }
      theme.id = `${encodeURIComponent(plugin.id)}:${theme.id}`
      theme.plugin = { id: plugin.id, generation: plugin.generation }
      if (themes.some((entry) => entry.id === theme.id)) throw new Error(`插件主题 ID 重复：${theme.id}`)
      themes.push(theme)
    }
  }
  return themes
}
