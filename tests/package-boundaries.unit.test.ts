import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

test('边界检查忽略 Vitest 产物，同时检查未跟踪的源码', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'package-boundaries-'))
  try {
    await mkdir(path.join(root, 'scripts'), { recursive: true })
    await mkdir(path.join(root, 'node_modules'))
    await mkdir(path.join(root, 'apps/web/.vitest/preview'), { recursive: true })
    await mkdir(path.join(root, 'apps/web/src'), { recursive: true })
    await symlink(path.resolve('node_modules/typescript'), path.join(root, 'node_modules/typescript'), 'junction')
    await writeFile(
      path.join(root, 'scripts/check-package-boundaries.mjs'),
      await readFile('scripts/check-package-boundaries.mjs'),
    )
    await writeFile(path.join(root, 'apps/web/package.json'), JSON.stringify({ name: 'web' }))
    const violations = "import 'undeclared-package'\nimport 'node:fs'\n"
    await writeFile(path.join(root, 'apps/web/.vitest/preview/ignored.ts'), violations)
    const run = () =>
      spawnSync(process.execPath, [path.join(root, 'scripts/check-package-boundaries.mjs')], { encoding: 'utf8' })
    assert.equal(run().status, 0)

    await writeFile(path.join(root, 'apps/web/src/untracked.ts'), violations)
    const result = run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /未在 package\.json 声明依赖：undeclared-package/)
    assert.match(result.stderr, /浏览器代码不得导入 Node\.js 或 Electron：node:fs/)
    assert.doesNotMatch(result.stderr, /\.vitest/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
