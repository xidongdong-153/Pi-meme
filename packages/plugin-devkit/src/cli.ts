import path from 'node:path'
import { realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createPlugin, preparePluginTools, type CreatePluginOptions } from './create'
import { buildPlugin, packagePlugin, validatePlugin } from './build'
import { checkPlugin, doctor } from './check'

export async function runDevkit(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      server: { type: 'string' },
      ui: { type: 'string' },
      resources: { type: 'string' },
      'display-name': { type: 'string' },
    },
  })
  const [command, directory, value] = positionals
  if (command === 'doctor' && positionals.length === 1 && !Object.keys(values).length) return doctor()
  if (!directory || !['create', 'prepare', 'check', 'build', 'validate', 'pack'].includes(command ?? ''))
    throw new Error(
      '用法：plugin-devkit doctor | create <目录> <包名> [--agent none|restricted|trusted|both] [--server none|restricted|trusted|both] [--ui none|panel|page] [--resources skills,themes,assets] [--display-name 名称] | prepare <目录> | check <目录> | build <目录> | validate <目录> | pack <目录> <输出.pim>',
    )
  if (command !== 'create' && Object.keys(values).length) throw new Error('能力选项仅用于 create')
  if (positionals.length !== (command === 'create' || command === 'pack' ? 3 : 2)) throw new Error('命令参数数量不正确')
  if (command === 'create') {
    if (!value) throw new Error('create 缺少插件包名')
    const options: CreatePluginOptions = {
      ...(values.agent !== undefined ? { agent: values.agent as CreatePluginOptions['agent'] } : {}),
      ...(values.server !== undefined ? { server: values.server as CreatePluginOptions['server'] } : {}),
      ...(values.ui !== undefined ? { ui: values.ui as CreatePluginOptions['ui'] } : {}),
      ...(values.resources !== undefined
        ? { resources: values.resources.split(',') as CreatePluginOptions['resources'] }
        : {}),
      ...(values['display-name'] !== undefined ? { displayName: values['display-name'] } : {}),
    }
    await doctor()
    return createPlugin(directory, value, options)
  }
  if (command === 'prepare') {
    await doctor()
    return preparePluginTools(directory)
  }
  if (command === 'check') return checkPlugin(directory)
  if (command === 'build') return buildPlugin(directory)
  if (command === 'validate') return validatePlugin(directory)
  if (!value) throw new Error('pack 缺少输出文件路径')
  return packagePlugin(directory, value)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href) {
  runDevkit(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((cause: unknown) => {
      console.error(`插件 ${process.argv[2] ?? '命令'} 失败：${cause instanceof Error ? cause.message : String(cause)}`)
      process.exitCode = 1
    })
}
