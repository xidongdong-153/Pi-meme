import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowsNativeExecutable } from '@pi-meme/windows-native/runtime'
import { readRuntimeSnapshot } from './runtime-snapshot'

async function ordinaryFile(value: string) {
  if (!path.isAbsolute(value)) throw new Error('runtime-path-invalid: 执行入口必须为绝对路径')
  const canonical = await realpath(value)
  const info = await lstat(canonical)
  if (!info.isFile() || info.nlink !== 1) throw new Error('runtime-path-invalid: 执行入口必须是独立普通文件')
  return canonical
}

function codeRoot(value: string) {
  const parts = path.resolve(value).split(path.sep)
  const container = parts.findIndex((part) => /\.(?:app|asar)$/i.test(part))
  if (container >= 0) return parts.slice(0, container + 1).join(path.sep) || path.parse(value).root
  return path.dirname(value)
}

/** These paths are selected at trusted startup and never rediscovered from a task's PATH. */
export async function executionRuntime(options: {
  dataRoot: string
  workerPath?: string
  restrictedNode?: string
  restrictedEntry?: string
}) {
  const snapshot = process.env.PI_MEME_RUNTIME_SNAPSHOT
    ? await readRuntimeSnapshot(process.env.PI_MEME_RUNTIME_SNAPSHOT, options.dataRoot)
    : undefined
  if (snapshot && options.workerPath && (await realpath(options.workerPath)) !== (await realpath(snapshot.workerPath)))
    throw new Error('runtime-snapshot-invalid: Worker 必须来自本次已验证快照')
  const worker =
    snapshot?.workerPath ?? options.workerPath ?? fileURLToPath(new URL('./session-worker.js', import.meta.url))
  if (!/\.(?:mjs|cjs|js)$/i.test(worker))
    throw new Error('runtime-snapshot-required: Worker 必须使用固定编译后的 JavaScript，不能加载项目 TypeScript')
  const workerPath = await ordinaryFile(worker)
  const selectedNode =
    snapshot?.nodePath ??
    options.restrictedNode ??
    process.env.PI_MEME_PLUGIN_NODE ??
    (process.versions.electron ? '' : process.execPath)
  if (!selectedNode) throw new Error('runtime-node-unavailable: 缺少固定 Node 运行时')
  const nodePath = await ordinaryFile(selectedNode)
  if (snapshot && options.restrictedNode && (await realpath(options.restrictedNode)) !== nodePath)
    throw new Error('runtime-snapshot-invalid: Node 必须来自本次已验证快照')
  const entry = snapshot?.restrictedEntry ?? options.restrictedEntry ?? process.env.PI_MEME_PLUGIN_ENTRY
  const restrictedEntry = entry ? await ordinaryFile(entry) : undefined
  if (snapshot && options.restrictedEntry && (await realpath(options.restrictedEntry)) !== restrictedEntry)
    throw new Error('runtime-snapshot-invalid: 插件入口必须来自本次已验证快照')
  if (snapshot && process.platform === 'win32') process.env.PI_MEME_WINDOWS_NATIVE = snapshot.windowsNativePath
  const nativePath = process.platform === 'win32' ? await windowsNativeExecutable() : undefined
  const sharedObjects = (() => {
    try {
      const report = process.report?.getReport() as { sharedObjects?: unknown }
      return Array.isArray(report.sharedObjects)
        ? report.sharedObjects.filter((item): item is string => typeof item === 'string' && path.isAbsolute(item))
        : []
    } catch {
      return []
    }
  })()
  const readOnlyRoots = [
    ...new Set([
      ...(snapshot ? [snapshot.root] : [codeRoot(workerPath)]),
      codeRoot(nodePath),
      codeRoot(process.execPath),
      ...(restrictedEntry ? [codeRoot(restrictedEntry)] : []),
      ...(nativePath ? [path.dirname(path.dirname(nativePath))] : []),
      ...sharedObjects.map(codeRoot),
    ]),
  ]
  return { workerPath, nodePath, nativePath, restrictedEntry, readOnlyRoots, snapshot }
}
