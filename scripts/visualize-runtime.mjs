import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const runtimeDirectory = fileURLToPath(new URL('../packages/visualize/src/runtime/', import.meta.url))
const runtimeNames = new Set(['core', 'echarts', 'capture', 'standalone'])
const prefix = 'virtual:visualize-runtime/'
const sourceQuery = '?visualize-source'

/** 将独立浏览器入口编译为字符串模块，绝不在宿主 window 中执行。 @returns {import('vite').Plugin} */
export function visualizationRuntimePlugin() {
  /** @type {Map<string, Promise<{ code: string; files: Set<string> }>>} */
  const cache = new Map()
  let mode = 'production'

  /** @param {string} name */
  function bundle(name) {
    const existing = cache.get(name)
    if (existing) return existing
    const files = new Set([path.join(runtimeDirectory, `${name}.ts`)])
    const pending = build({
      configFile: false,
      envFile: false,
      root: path.resolve(runtimeDirectory, '../..'),
      publicDir: false,
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      mode,
      logLevel: 'error',
      plugins: [
        {
          name: 'visualize-runtime-dependencies',
          transform(_code, id) {
            const file = id.split('?')[0]
            if (path.isAbsolute(file)) files.add(file)
          },
        },
      ],
      build: {
        write: false,
        emptyOutDir: false,
        sourcemap: false,
        minify: true,
        target: 'es2022',
        reportCompressedSize: false,
        lib: {
          entry: path.join(runtimeDirectory, `${name}.ts`),
          name: `PiVisualize_${name}`,
          formats: ['iife'],
        },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    })
      .then((result) => {
        if ('on' in result) throw new Error('可视化运行时不支持 watch 构建')
        const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output)
        const chunks = outputs.filter((entry) => entry.type === 'chunk')
        if (chunks.length !== 1 || outputs.length !== 1 || chunks[0].imports.length)
          throw new Error(`可视化运行时 ${name} 必须为单个自包含 IIFE`)
        return { code: chunks[0].code, files }
      })
      .catch((cause) => {
        if (cache.get(name) === pending) cache.delete(name)
        throw cause
      })
    cache.set(name, pending)
    return pending
  }

  return {
    name: 'visualize-runtime',
    enforce: 'pre',
    configResolved(config) {
      mode = config.mode
    },
    resolveId(id, importer) {
      if (!importer || !id.endsWith(sourceQuery)) return
      const file = path.resolve(path.dirname(importer), id.slice(0, -sourceQuery.length))
      const name = path.basename(file, '.ts')
      if (runtimeNames.has(name) && file === path.join(runtimeDirectory, `${name}.ts`)) return `\0${prefix}${name}`
    },
    async load(id) {
      if (!id.startsWith(`\0${prefix}`)) return
      const name = id.slice(prefix.length + 1)
      if (!runtimeNames.has(name)) return
      const { code, files } = await bundle(name)
      for (const file of files) this.addWatchFile(file)
      return `export default ${JSON.stringify(code)}`
    },
    watchChange() {
      cache.clear()
    },
    handleHotUpdate(context) {
      if (!context.file.startsWith(runtimeDirectory)) return
      cache.clear()
      for (const name of runtimeNames) {
        const module = context.server.moduleGraph.getModuleById(`\0${prefix}${name}`)
        if (module) context.server.moduleGraph.invalidateModule(module)
      }
      context.server.ws.send({ type: 'full-reload' })
      return []
    },
  }
}
