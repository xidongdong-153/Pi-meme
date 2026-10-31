import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const repo = fileURLToPath(new URL('..', import.meta.url))
export const windowsNativePath = path.join(repo, 'packages/windows-native/native/target/release/pi-meme-windows.exe')

export async function prepareWindowsNative(destination?: string) {
  if (process.platform !== 'win32') return
  const userCargo = path.join(homedir(), '.cargo/bin/cargo.exe')
  let cargo = 'cargo.exe'
  try {
    await access(userCargo)
    cargo = userCargo
  } catch {
    /* 由 PATH 中的 Cargo 返回构建诊断。 */
  }
  try {
    await execute(
      cargo,
      [
        'rustc',
        '--locked',
        '--release',
        '--manifest-path',
        path.join(repo, 'packages/windows-native/native/Cargo.toml'),
        '--',
        '-C',
        'target-feature=+crt-static',
      ],
      {
        cwd: repo,
        windowsHide: true,
        timeout: 10 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      },
    )
  } catch (cause) {
    throw new Error(
      `Windows 原生程序构建失败，请检查 Rust MSVC、Visual C++ Build Tools 和 Windows SDK：${String(cause)}`,
    )
  }
  if (destination) {
    await mkdir(destination, { recursive: true })
    await copyFile(windowsNativePath, path.join(destination, 'pi-meme-windows.exe'))
    const { stdout } = await execute(
      cargo,
      [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--filter-platform',
        'x86_64-pc-windows-msvc',
        '--manifest-path',
        path.join(repo, 'packages/windows-native/native/Cargo.toml'),
      ],
      { cwd: repo, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    )
    const metadata = JSON.parse(stdout) as {
      packages: Array<{ id: string; name: string; version: string; manifest_path: string; source: string | null }>
      resolve: { root: string; nodes: Array<{ id: string; dependencies: string[] }> }
    }
    const graph = new Map(metadata.resolve.nodes.map((node) => [node.id, node.dependencies]))
    const included = new Set<string>()
    const pending = [metadata.resolve.root]
    while (pending.length) {
      const id = pending.pop()!
      if (included.has(id)) continue
      included.add(id)
      pending.push(...(graph.get(id) ?? []))
    }
    const licenses: string[] = []
    for (const dependency of metadata.packages.filter((entry) => entry.source && included.has(entry.id))) {
      const directory = path.dirname(dependency.manifest_path)
      const names = (await readdir(directory)).filter((name) => /^LICENSE(?:[-.]|$)|^COPYING(?:[-.]|$)/i.test(name))
      if (!names.length) {
        const name = `${dependency.name}-${dependency.version}.txt`
        const contents = await readFile(path.join(repo, 'packages/windows-native/native/licenses', name), 'utf8').catch(
          () => {
            throw new Error(`Windows 原生依赖缺少许可文件：${dependency.name}`)
          },
        )
        licenses.push(`${dependency.name} ${dependency.version} / ${name}\n\n${contents}`)
      }
      for (const name of names)
        licenses.push(
          `${dependency.name} ${dependency.version} / ${name}\n\n${await readFile(path.join(directory, name), 'utf8')}`,
        )
    }
    await writeFile(path.join(destination, '../WINDOWS_NATIVE_LICENSES.txt'), licenses.join('\n\n'))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32') throw new Error('Windows 原生程序需在 Windows x64 环境中构建')
  await prepareWindowsNative()
}
