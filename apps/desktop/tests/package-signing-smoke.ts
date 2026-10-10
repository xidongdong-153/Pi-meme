import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagedApp =
  process.env.PI_DESKTOP_PACKAGED_APP ??
  path.join(desktopDirectory, 'out', `pi-meme-darwin-${process.arch}`, 'pi-meme.app')
const skip =
  process.platform !== 'darwin'
    ? 'macOS 签名检查只适用于 Darwin'
    : !existsSync(packagedApp)
      ? '尚未生成 macOS 打包应用'
      : false

test('macOS 打包应用具有有效的完整签名', { skip }, () => {
  const result = spawnSync('codesign', ['--verify', '--deep', '--strict', packagedApp], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})
