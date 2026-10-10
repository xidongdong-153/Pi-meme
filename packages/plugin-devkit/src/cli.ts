import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlugin } from './create'
import { buildPlugin, packagePlugin, validatePlugin } from './build'

export async function runDevkit(args: string[]) {
  const [command, directory, value] = args
  if (!directory || !['create', 'build', 'validate', 'pack'].includes(command ?? ''))
    throw new Error(
      '用法：plugin-devkit create <目录> <包名> | build <目录> | validate <目录> | pack <目录> <输出.pim>',
    )
  if (command === 'create') {
    if (!value) throw new Error('create 缺少插件包名')
    return createPlugin(directory, value)
  }
  if (command === 'build') return buildPlugin(directory)
  if (command === 'validate') return validatePlugin(directory)
  if (!value) throw new Error('pack 缺少输出文件路径')
  return packagePlugin(directory, value)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDevkit(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((cause: unknown) => {
      console.error(cause instanceof Error ? cause.message : String(cause))
      process.exitCode = 1
    })
}
