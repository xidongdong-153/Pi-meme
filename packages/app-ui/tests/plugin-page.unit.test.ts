import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PluginClient } from '@pi-meme/client/plugin-client'
import { PluginPage } from '../src/settings/plugin-page'
import { plugin } from './integration-pages-fixture'

test('旧 Host 的文件和终端安装条目不会出现在可停用的普通插件列表中', () => {
  const html = renderToStaticMarkup(
    createElement(PluginPage, {
      client: {} as PluginClient,
      plugins: ['@pi-meme/file-directory', '@pi-meme/terminal'].map((id) => ({ ...plugin, id })),
      errors: {},
      onChanged: async () => {},
    }),
  )
  assert.doesNotMatch(html, /启用插件：@pi-meme\/(?:file-directory|terminal)/)
  assert.match(html, /没有个人插件/)
})
