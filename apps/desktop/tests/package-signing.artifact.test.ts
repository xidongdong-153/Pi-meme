import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { hash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagedApp =
  process.env.PI_DESKTOP_PACKAGED_APP ??
  path.join(desktopDirectory, 'out', `pi-meme-darwin-${process.arch}`, 'pi-meme.app')
const skip = process.platform !== 'darwin' ? 'macOS 签名检查只适用于 Darwin' : false

test('macOS 打包应用具有有效的完整签名', { skip }, () => {
  assert.ok(existsSync(packagedApp), `缺少打包应用：${packagedApp}`)
  const result = spawnSync('codesign', ['--verify', '--deep', '--strict', packagedApp], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})

test('macOS 打包应用保留 Electron 与 Chromium 的完整许可', { skip }, async () => {
  const distribution = path.join(desktopDirectory, 'out', `pi-meme-darwin-${process.arch}`)
  for (const [source, target] of [
    ['LICENSE', 'ELECTRON_LICENSE'],
    ['LICENSES.chromium.html', 'LICENSES.chromium.html'],
  ])
    assert.equal(
      hash('sha256', await readFile(path.join(packagedApp, 'Contents/Resources', target))),
      hash('sha256', await readFile(path.join(distribution, source))),
      `Electron 发行许可必须完整分发：${source}`,
    )
})
