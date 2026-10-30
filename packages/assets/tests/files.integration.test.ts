import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import { pathToFileURL } from 'node:url'
import {
  agentAvatars,
  builtinCommandIcons,
  defaultUserAvatar,
  systemPluginIcons,
  systemSkillIcons,
} from '../src/builtin'
import { fileIconSprite, resolveFileIcon } from '../src/file-icons'
import { fileExtensionIcons, fileNameIcons, folderNameIcons } from '../src/file-icon-data'

const filesRoot = path.resolve(import.meta.dirname, '../files')

const rendererFiles = [
  'profile/default-avatar.png',
  'agents/general.png',
  'agents/research.png',
  'agents/plan.png',
  'agents/code.png',
  'agents/review.png',
  'agents/test.png',
  'agents/design.png',
  'agents/docs.png',
  'agents/frontend.png',
  'agents/backend.png',
  'agents/database.png',
  'agents/devops.png',
  'agents/security.png',
  'agents/debug.png',
  'agents/performance.png',
  'agents/refactor.png',
  'agents/browser.png',
  'agents/data.png',
  'agents/product.png',
  'agents/localization.png',
  'system-plugins/visualize.png',
  'system-plugins/git.png',
  'system-plugins/file-directory.png',
  'system-plugins/terminal.png',
  'system-skills/skill-creator.png',
  'system-skills/plugin-creator.png',
  'commands/plan.png',
  'commands/goal.png',
  'commands/compact.png',
  'commands/name.png',
  'brand/pi-dev-dark-128x128.png',
  'brand/pi-dev-light-128x128.png',
]

const desktopFiles = [
  'desktop/dock/pi-dev-dark-512x512.png',
  'desktop/dock/pi-dev-light-512x512.png',
  'desktop/icons/pi-dev-dark.icns',
  'desktop/icons/pi-dev-dark.ico',
  'desktop/icons/pi-dev-light.icns',
  'desktop/icons/pi-dev-light.ico',
]

test('内置图片都在 files 目录，界面引用指向这些文件', () => {
  const referenced = [
    defaultUserAvatar,
    ...agentAvatars,
    ...Object.values(systemPluginIcons),
    ...Object.values(systemSkillIcons),
    ...Object.values(builtinCommandIcons),
  ]
  assert.deepEqual(
    referenced,
    rendererFiles
      .filter((file) => !file.startsWith('brand/'))
      .map((file) => pathToFileURL(path.join(filesRoot, file)).href),
  )
  for (const file of [...rendererFiles, ...desktopFiles]) {
    assert.equal(fs.existsSync(path.join(filesRoot, file)), true, file)
  }
})

test('内置文件图标的所有映射和展开状态都包含在本地 SVG 中', () => {
  const sprite = fs.readFileSync(new URL(fileIconSprite), 'utf8')
  const ids = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1])
  const symbols = new Set(ids)
  assert.equal(symbols.size, ids.length)
  for (const icon of [
    '_file',
    '_folder',
    '_folder_open',
    ...Object.values(fileNameIcons),
    ...Object.values(fileExtensionIcons),
    ...Object.values(folderNameIcons).flatMap((name) => [name, `${name}_open`]),
  ])
    assert.ok(symbols.has(icon), icon)
  assert.doesNotMatch(sprite, /<(?:script|foreignObject)\b|\b(?:href|onload)=/i)
  const css = fs.readFileSync(path.join(filesRoot, '../src/file-icons.css'), 'utf8')
  for (const match of sprite.matchAll(/var\((--file-icon-[\w-]+)\)/g)) assert.ok(css.includes(`${match[1]}:`), match[1])
  assert.match(fs.readFileSync(path.join(filesRoot, 'file-icons/LICENSE'), 'utf8'), /Copyright \(c\) 2023 Catppuccin/)
})

test('文件图标按文件名、最长扩展名和目录名匹配，未知类型使用默认图标', () => {
  assert.equal(resolveFileIcon('src/main.ts'), 'typescript')
  assert.equal(resolveFileIcon('C:\\project\\MAIN.TS'), 'typescript')
  assert.equal(resolveFileIcon('package.json'), fileNameIcons['package.json'])
  assert.notEqual(resolveFileIcon('package.json'), resolveFileIcon('other.json'))
  assert.equal(resolveFileIcon('src/types.d.ts'), fileExtensionIcons['d.ts'])
  assert.equal(resolveFileIcon('README.md'), fileNameIcons['readme.md'])
  assert.equal(resolveFileIcon('src', true), folderNameIcons.src)
  assert.equal(resolveFileIcon('src', true, true), `${folderNameIcons.src}_open`)
  assert.equal(resolveFileIcon('unknown-file.extension'), '_file')
  assert.equal(resolveFileIcon('constructor'), '_file')
  assert.equal(resolveFileIcon('unknown-directory', true, true), '_folder_open')
})
