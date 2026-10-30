import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'

type Lockfile = {
  lockfileVersion: string
  packages: Record<string, { resolution: unknown }>
  snapshots: Record<string, unknown>
}

export function assertLockedDependencies(source: string, staged: string) {
  const before = parse(source) as Lockfile
  const after = parse(staged) as Lockfile
  assert.equal(after.lockfileVersion, before.lockfileVersion, '发布暂存锁文件格式发生变化')
  const external = (entries: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(entries).filter(([key]) => !key.includes('@file:')))
  const resolutions = (lock: Lockfile) =>
    Object.fromEntries(
      Object.entries(lock.packages)
        .filter(([key]) => !key.includes('@file:'))
        .map(([key, { resolution }]) => [key, resolution]),
    )
  assert.deepEqual(resolutions(after), resolutions(before), '发布暂存改变了锁定的外部依赖或校验值')
  assert.deepEqual(external(after.snapshots), external(before.snapshots), '发布暂存改变了锁定的外部依赖图')
}

export async function stageHostWorkspace(repo: string, workspace: string) {
  await mkdir(workspace, { recursive: true })
  for (const file of ['.npmrc', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    await copyFile(path.join(repo, file), path.join(workspace, file))
  const excluded = new Set(['node_modules', '.git', '.vite', '.vitest', 'out'])
  for (const directory of ['apps', 'packages', 'plugins', 'patches'])
    await cp(path.join(repo, directory), path.join(workspace, directory), {
      recursive: true,
      filter: (source) =>
        !excluded.has(path.basename(source)) &&
        !path.basename(source).startsWith('.env') &&
        !source.endsWith('.tsbuildinfo'),
    })
  const manifestFile = path.join(workspace, 'package.json')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  const desktop = JSON.parse(await readFile(path.join(repo, 'apps/desktop/package.json'), 'utf8'))
  // 注入副本沿用既有类型 peer，避免冷缓存生成不同的依赖上下文。
  for (const name of ['@types/react', '@types/react-dom'])
    manifest.devDependencies[name] = desktop.devDependencies[name]
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const file = path.join(workspace, 'pnpm-workspace.yaml')
  const config = parse(await readFile(file, 'utf8')) as Record<string, unknown>
  config.injectWorkspacePackages = true
  await writeFile(file, stringify(config))
}
