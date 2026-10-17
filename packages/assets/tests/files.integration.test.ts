import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import { pathToFileURL } from 'node:url'
import { agentAvatars, defaultUserAvatar, systemPluginIcons, systemSkillIcons } from '../src/builtin'

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
  'system-plugins/git.png',
  'system-plugins/file-directory.png',
  'system-plugins/terminal.png',
  'system-skills/skill-creator.png',
  'system-skills/plugin-creator.png',
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
