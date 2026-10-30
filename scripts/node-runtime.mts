import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { nodeVersion, repoRoot, sha256 } from './release.mjs'

async function download(url: string, file: string) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000) })
  if (!response.ok) throw new Error(`下载 Node.js 失败：${response.status}`)
  await writeFile(file, new Uint8Array(await response.arrayBuffer()))
}
export async function prepareNodeRuntime(destination: string, platform = process.platform, arch = process.arch) {
  assert.ok(
    ['darwin', 'linux', 'win32'].includes(platform) && ['arm64', 'x64'].includes(arch),
    'Node 运行时只支持 macOS/Linux/Windows arm64/x64',
  )
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-node-runtime-'))
  try {
    const windows = platform === 'win32'
    const distribution = `node-v${nodeVersion}-${windows ? 'win' : platform}-${arch}`
    const name = `${distribution}.${windows ? 'zip' : 'tar.gz'}`
    const archive = path.join(directory, name)
    const sums = path.join(directory, 'SHASUMS256.txt')
    const base = `https://nodejs.org/dist/v${nodeVersion}`
    await download(`${base}/SHASUMS256.txt`, sums)
    await download(`${base}/${name}`, archive)
    const expected = (await readFile(sums, 'utf8'))
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, file]) => file === name)?.[0]
    assert.ok(expected && /^[a-f\d]{64}$/.test(expected), '官方校验清单缺少当前 Node.js 运行时')
    assert.equal(await sha256(archive), expected, 'Node.js 归档 SHA256 校验失败')
    execFileSync('tar', ['-xf', archive, '-C', directory], { windowsHide: true })
    await mkdir(path.join(destination, 'bin'), { recursive: true })
    const executable = path.join(destination, 'bin', windows ? 'node.exe' : 'node')
    await copyFile(path.join(directory, distribution, windows ? 'node.exe' : 'bin/node'), executable)
    if (!windows) await chmod(executable, 0o755)
    await copyFile(path.join(directory, distribution, 'LICENSE'), path.join(destination, 'LICENSE'))
    await copyFile(
      path.join(repoRoot, 'packages/plugin-runtime/src/restricted-entry.mjs'),
      path.join(destination, 'restricted-entry.mjs'),
    )
    await writeFile(
      path.join(destination, 'runtime.json'),
      JSON.stringify({ nodeVersion, platform, arch, archive: name, sha256: expected }, null, 2),
    )
    return { nodeVersion, archive: name, sha256: expected }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
