import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Pi 与 Chord 各自固定依赖版本。复制 hoisted 安装时保留 Chord 实际使用的嵌套副本。
 * @param {string} nodeModules 源 node_modules 目录
 */
export function chordPackagePaths(nodeModules) {
  const chord = '@earendil-works/chord'
  const packages = [chord]
  for (const name of ['@earendil-works/pi-schema', '@earendil-works/pi-telemetry']) {
    packages.push(name)
    const nested = `${chord}/node_modules/${name}`
    if (existsSync(path.join(nodeModules, nested, 'package.json'))) packages.push(nested)
  }
  return packages
}
