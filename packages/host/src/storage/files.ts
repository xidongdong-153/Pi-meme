import { randomUUID, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export function contains(root: string, value: string) {
  const relative = path.relative(root, value)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
export async function optionalStat(file: string) {
  try {
    return await lstat(file)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw cause
  }
}
export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
}
export async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = path.join(path.dirname(file), `.storage-${randomUUID()}.tmp`)
  try {
    const descriptor = await open(temporary, 'wx', 0o600)
    try {
      await descriptor.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await descriptor.sync()
    } finally {
      await descriptor.close()
    }
    await rename(temporary, file)
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(file), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
export async function writeText(file: string, content: string) {
  const temporary = path.join(path.dirname(file), `.storage-${randomUUID()}.tmp`)
  try {
    const descriptor = await open(temporary, 'w', 0o600)
    try {
      await descriptor.writeFile(content)
      await descriptor.sync()
    } finally {
      await descriptor.close()
    }
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
export async function digest(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
/** 拒绝中间目录或末端链接；维护操作不穿过未知路径重定向。 */
export async function physicalPath(root: string, relative: string) {
  const canonical = await realpath(root)
  const target = path.resolve(canonical, relative)
  if (!contains(canonical, target)) throw new Error('存储路径超出数据目录')
  let current = canonical
  for (const segment of path.relative(canonical, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const info = await optionalStat(current)
    if (!info) return null
    if (info.isSymbolicLink()) throw new Error(`存储维护不允许路径链接：${current}`)
  }
  return target
}
export async function listFiles(root: string): Promise<string[]> {
  const result: string[] = []
  if (!(await optionalStat(root))) return result
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...(await listFiles(file)))
    else if (entry.isFile()) result.push(file)
    else throw new Error(`应用元数据目录含有不支持的文件：${file}`)
  }
  return result
}
