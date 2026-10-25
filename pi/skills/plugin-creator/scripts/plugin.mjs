import path from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = path.resolve(import.meta.dirname, '../dist/toolchain/cli.mjs')
try {
  const { runDevkit } = await import(pathToFileURL(entry).href)
  console.log(JSON.stringify(await runDevkit(process.argv.slice(2)), null, 2))
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause)
  console.error(`插件 ${process.argv[2] ?? '命令'} 失败：${message}`)
  if (cause?.code === 'ERR_MODULE_NOT_FOUND')
    console.error(
      '技能工具或依赖缺失；源码开发请运行 pnpm exec tsx scripts/prepare-plugin-tools.mts，已安装应用请更新应用后重启 Host。',
    )
  process.exitCode = 1
}
