import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import ts from 'typescript'

export const diagnosticHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => '\n',
}

const moduleDirectory = import.meta.dirname
let prepared: Promise<string> | undefined

/** 源码开发时准备工具；分发后的 CLI 直接使用同目录的固定版本工具。 */
export async function toolchainDirectory(): Promise<string> {
  try {
    await access(path.join(moduleDirectory, 'toolchain.json'))
    return moduleDirectory
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  prepared ??= prepareToolchain()
  return prepared
}

async function prepareToolchain() {
  const repo = path.resolve(moduleDirectory, '../../..')
  const hash = createHash('sha256').update(`${process.platform}/${process.arch}`)
  async function fingerprint(relative: string) {
    const file = path.join(repo, relative)
    hash.update(relative)
    const entries = await readdir(file, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOTDIR') return undefined
      throw cause
    })
    if (entries)
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
        await fingerprint(path.join(relative, entry.name))
    else hash.update(await readFile(file))
  }
  for (const file of [
    'pnpm-lock.yaml',
    'packages/plugin-devkit/src',
    'packages/plugin-runtime/src',
    'packages/plugin-sdk/src',
    'packages/plugin-sdk/package.json',
    'packages/contracts/src',
    'packages/contracts/package.json',
    'pi/skills/plugin-creator/assets/templates',
    'LICENSE',
    'pi/skills/skill-creator/scripts/quick-validate.mjs',
    'pi/skills/skill-creator/license.txt',
  ])
    await fingerprint(file)
  const output = path.resolve(moduleDirectory, '../dist/toolchains', hash.digest('hex'))
  try {
    await access(path.join(output, 'toolchain.json'))
    return output
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
  await mkdir(path.dirname(output), { recursive: true })
  const staging = await mkdtemp(`${output}-`)
  try {
    const modules = path.join(staging, 'node_modules')
    const packages = [
      'esbuild',
      `@esbuild/${process.platform}-${process.arch}`,
      '@earendil-works/chord',
      'typescript',
      '@types/node',
      '@types/react',
      'csstype',
      'undici-types',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-agent-core',
    ]
    for (const name of packages) {
      const source = path.join(repo, 'node_modules', name)
      await cp(source, path.join(modules, name), {
        recursive: true,
        dereference: true,
        filter: (file) => {
          const relative = path.relative(source, file)
          if (!relative) return true
          if (relative.split(path.sep).includes('node_modules') || file.endsWith('.map')) return false
          if (name === 'typescript')
            return (
              !path.extname(file) ||
              /(?:package\.json|typescript\.js|lib\.[\w.]+\.d\.ts|LICENSE\.txt|NOTICE\.txt)$/.test(file)
            )
          if (name.startsWith('@earendil-works/pi-'))
            return !path.extname(file) || /(?:\.d\.ts|package\.json|LICENSE|LICENSE\.md)$/.test(file)
          return true
        },
      })
    }
    await writeSdk(repo, staging)
    await cp(path.join(repo, 'LICENSE'), path.join(staging, 'LICENSE'))
    await mkdir(path.join(staging, 'notices'), { recursive: true })
    await cp(path.join(repo, 'node_modules/acorn/LICENSE'), path.join(staging, 'notices/acorn-LICENSE'))
    await cp(
      path.join(repo, 'pi/skills/skill-creator/license.txt'),
      path.join(staging, 'notices/skill-creator-LICENSE'),
    )
    await mkdir(path.join(staging, 'scripts'), { recursive: true })
    await cp(
      path.join(repo, 'pi/skills/skill-creator/scripts/quick-validate.mjs'),
      path.join(staging, 'scripts/quick-validate.mjs'),
    )
    await cp(path.join(repo, 'pi/skills/plugin-creator/assets/templates'), path.join(staging, 'templates'), {
      recursive: true,
    })
    await build({
      entryPoints: [path.join(moduleDirectory, 'cli.ts')],
      outfile: path.join(staging, 'cli.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22.19',
      external: ['esbuild', 'typescript', '@earendil-works/chord', '@earendil-works/chord/*'],
      logLevel: 'silent',
    })
    await writeFile(
      path.join(staging, 'toolchain.json'),
      `${JSON.stringify({ sdkVersion: 3, platform: process.platform, arch: process.arch, node: '22.19.0' }, null, 2)}\n`,
    )
    try {
      await rename(staging, output)
    } catch (cause) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause
      await access(path.join(output, 'toolchain.json'))
    }
    return output
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function writeSdk(repo: string, output: string) {
  const roots = ['plugin-sdk', 'contracts'].map((name) => path.join(repo, 'packages', name, 'src'))
  const files = (await Promise.all(roots.map((root) => readdir(root)))).flatMap((names, i) =>
    names.filter((name) => name.endsWith('.ts')).map((name) => path.join(roots[i], name)),
  )
  const declarations = path.join(output, 'declarations')
  const program = ts.createProgram(files, {
    declaration: true,
    emitDeclarationOnly: true,
    outDir: declarations,
    rootDir: path.join(repo, 'packages'),
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
  })
  const result = program.emit()
  if (result.emitSkipped || result.diagnostics.length)
    throw new Error(`无法生成 SDK 类型：${ts.formatDiagnosticsWithColorAndContext(result.diagnostics, diagnosticHost)}`)
  for (const name of ['plugin-sdk', 'contracts']) {
    const source = path.join(repo, 'packages', name)
    const target = path.join(output, 'node_modules/@pi-meme', name)
    await mkdir(target, { recursive: true })
    await cp(path.join(declarations, name, 'src'), path.join(target, 'src'), { recursive: true })
    const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')) as {
      name: string
      version: string
      exports: Record<string, string>
    }
    await writeFile(
      path.join(target, 'package.json'),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        type: 'module',
        exports: Object.fromEntries(
          Object.entries(manifest.exports).map(([key, value]) => [
            key,
            { types: value.replace(/\.ts$/, '.d.ts'), default: value.replace(/\.ts$/, '.js') },
          ]),
        ),
      }),
    )
    await build({
      entryPoints: files.filter((file) => file.startsWith(`${source}${path.sep}`)),
      outdir: path.join(target, 'src'),
      format: 'esm',
      platform: 'node',
      target: 'node22.19',
      logLevel: 'silent',
    })
  }
  await rm(declarations, { recursive: true })
}
