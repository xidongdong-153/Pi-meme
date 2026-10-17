import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { assertPortableLinks, nodeVersion, releaseInfo, releaseResourceFiles } from '../../scripts/release.mjs'

export async function serverArtifact(repo: string, root: string, data: string) {
  const bundle = process.env.PI_MEME_HOST_BUNDLE_ROOT ? await realpath(process.env.PI_MEME_HOST_BUNDLE_ROOT) : undefined
  const node = bundle ? path.join(bundle, 'runtime/bin/node') : process.execPath
  const command = bundle ? path.join(bundle, 'bin/pi-meme-host') : node
  if (bundle) {
    const relative = path.relative(await realpath(repo), bundle)
    assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Host 分发包必须解压到仓库外验收')
    await assertPortableLinks(bundle)
    await access(command, constants.X_OK)
    await access(node, constants.X_OK)
    const metadata = JSON.parse(await readFile(path.join(bundle, 'release.json'), 'utf8'))
    const info = await releaseInfo()
    assert.equal(metadata.version, info.version)
    assert.equal(metadata.commit, info.commit)
    assert.equal(metadata.platform, process.platform)
    assert.equal(metadata.arch, process.arch)
    assert.equal(metadata.nodeVersion, nodeVersion)
    assert.equal(execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(), `v${nodeVersion}`)
    for (const file of [...releaseResourceFiles, 'runtime/LICENSE', 'apps/web/dist/index.html'])
      assert.ok((await readFile(path.join(bundle, file))).length > 0, `Host 分发包缺少 ${file}`)
  }
  return {
    bundled: Boolean(bundle),
    node,
    command,
    args: bundle ? [] : [path.join(repo, 'apps/server/dist/main.js')],
    cwd: root,
    env: {
      PATH: bundle ? '/usr/bin:/bin:/usr/sbin:/sbin' : process.env.PATH,
      HOME: root,
      PI_MEME_DATA_ROOT: data,
      PI_MEME_TEST_CREDENTIALS: 'memory',
      PI_MEME_PORT: '0',
    },
  }
}
