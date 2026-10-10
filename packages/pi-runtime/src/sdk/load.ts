import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Pi SDK 运行时入口。
 *
 * 打包与开发统一加载 pi 包自带的 bundle：`dist/bundle/index.js` 内联了除 jiti、
 * quickjs-wasi、photon-node 之外的全部依赖，随应用一起分发即可，不需要用户安装 pi。
 */
export type PiSdk = typeof import('@earendil-works/pi-coding-agent')

const piPackage = path.join('@earendil-works', 'pi-coding-agent')

/** Vite 产物里 import.meta.url 会被内联成空值，优先使用 CJS 的 __dirname。 */
function moduleDirectory() {
  if (typeof __dirname === 'string') return __dirname
  return path.dirname(fileURLToPath(import.meta.url))
}

function findPiPackageRoot() {
  const start = moduleDirectory()
  let current = start
  const maxDepth = 15
  for (let depth = 0; depth < maxDepth; depth++) {
    const candidate = path.join(current, 'node_modules', piPackage)
    if (fs.existsSync(path.join(candidate, 'dist', 'bundle', 'index.js'))) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`未找到 ${piPackage}：从 ${start} 逐级向上查找 node_modules 均失败`)
}

let sdk: Promise<PiSdk> | null = null

export function loadPiSdk(): Promise<PiSdk> {
  sdk ??= import(pathToFileURL(path.join(findPiPackageRoot(), 'dist', 'bundle', 'index.js')).href) as Promise<PiSdk>
  return sdk
}

export type PiAgentCore = typeof import('@earendil-works/pi-agent-core')

let agentCore: Promise<PiAgentCore> | null = null

export function loadPiAgentCore(): Promise<PiAgentCore> {
  const directory = path.join(path.dirname(findPiPackageRoot()), 'pi-agent-core', 'dist')
  const bundled = path.join(directory, 'index.bundle.js')
  agentCore ??= import(
    pathToFileURL(fs.existsSync(bundled) ? bundled : path.join(directory, 'index.js')).href
  ) as Promise<PiAgentCore>
  return agentCore
}

let cachedVersion: string | undefined

export function getPiVersion(): string | undefined {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const root = findPiPackageRoot()
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }
    if (pkg.version) {
      cachedVersion = pkg.version
      return cachedVersion
    }
  } catch {}
  return undefined
}
