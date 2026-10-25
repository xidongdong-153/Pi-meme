import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { builtinModules } from 'node:module'
import ts from 'typescript'

const root = path.resolve(import.meta.dirname, '..')
const failures = []
const manifests = new Map()
const areas = ['apps', 'packages', 'plugins'].filter((area) => fs.existsSync(path.join(root, area)))
const businessPackages = new Set(
  [
    'activities',
    'schedules',
    'chat',
    'workspace',
    'history',
    'models',
    'settings',
    'resources',
    'interaction',
    'subagents',
    'mcp',
    'codemode',
    'permissions',
    'sandbox-macos',
    'sandbox-linux',
    'usage',
    'goals',
    'git',
    'file-directory',
    'terminal',
  ].map((name) => `@pi-meme/${name}`),
)
const nodeModules = new Set(builtinModules)
for (const area of areas) {
  for (const name of fs.readdirSync(path.join(root, area))) {
    const directory = `${area}/${name}`
    const file = path.join(root, directory, 'package.json')
    if (!fs.existsSync(file)) continue
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifests.set(directory, {
      name: manifest.name,
      deps: { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies },
    })
  }
}
const byName = new Map([...manifests].map(([directory, manifest]) => [manifest.name, directory]))
function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'out', '.vite', '.git', 'dist'].includes(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (/\.(?:ts|tsx|mts|mjs)$/.test(entry.name)) files.push(full)
  }
  return files
}
const files = areas.flatMap((directory) => walk(path.join(root, directory)))
const locate = (file) => file.match(/^(?:apps|packages|plugins)\/[^/]+/)?.[0]
function browserFile(file) {
  return /\/src\/(?:ui|renderer)\//.test(file) || /^(?:apps\/web|packages\/(?:client|app-ui))\/src\//.test(file)
}
function specifiers(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const values = []
  const visit = (node) => {
    const literal =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined
    if (literal && ts.isStringLiteral(literal))
      values.push({ value: literal.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}
const fail = (file, line, message) => failures.push(`${file}:${line} ${message}`)
for (const full of files) {
  const file = path.relative(root, full).split(path.sep).join('/')
  const owner = locate(file)
  const manifest = manifests.get(owner)
  for (const { value, line } of specifiers(full)) {
    const browser = browserFile(file)
    if (value.startsWith('node:') || nodeModules.has(value) || value === 'electron' || value.startsWith('electron/')) {
      if (browser) fail(file, line, `浏览器代码不得导入 Node.js 或 Electron：${value}`)
      if (value === 'electron' && !owner?.startsWith('apps/desktop') && !file.includes('/tests/'))
        fail(file, line, 'Electron 仅用于桌面平台层')
      continue
    }
    if (value.startsWith('.')) {
      const target = path
        .relative(root, path.resolve(path.dirname(full), value))
        .split(path.sep)
        .join('/')
      const targetOwner = locate(target)
      const fixture = file.includes('/tests/') && target.startsWith('tests/fixtures/')
      const buildConfiguration = /\.config\.(?:ts|mts)$/.test(file)
      if (owner !== targetOwner && !fixture && !buildConfiguration) fail(file, line, `相对导入穿透到包外：${value}`)
      if (browser && /\/src\/(?:server|agent|main)\//.test(target))
        fail(file, line, `浏览器代码不得导入 Server、Agent 或主进程实现：${value}`)
      continue
    }
    const base = value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0]
    if (manifest && !manifest.deps[base]) fail(file, line, `未在 package.json 声明依赖：${value}`)
    const target = byName.get(base)
    if (target) {
      if (target.startsWith('apps/') && !/\.config\.(?:ts|mts)$/.test(file))
        fail(file, line, `包不得反向导入应用：${value}`)
      if (owner === 'packages/contracts') fail(file, line, `contracts 不得导入其他 workspace 包：${value}`)
      if (
        owner !== target &&
        ((businessPackages.has(manifest?.name) && businessPackages.has(base)) ||
          (owner?.startsWith('plugins/') && target.startsWith('plugins/')))
      )
        fail(file, line, `业务包和插件之间通过契约、Props 或声明的服务通信：${value}`)
      if (
        [
          'packages/pi-runtime',
          'packages/pi-adapter',
          'packages/plugin-runtime',
          'packages/plugin-sdk',
          'packages/plugin-devkit',
          'packages/client',
          'packages/ui',
          'packages/assets',
        ].includes(owner) &&
        (businessPackages.has(base) || target.startsWith('plugins/'))
      )
        fail(file, line, `基础包不得反向依赖业务实现或插件：${value}`)
      if (browser && /\/(?:server|agent|main)(?:\/|$)/.test(value))
        fail(file, line, `浏览器代码不得导入 Server、Agent 或主进程实现：${value}`)
      if (
        browser &&
        ['packages/host', 'packages/pi-runtime', 'packages/pi-adapter', 'packages/plugin-runtime'].includes(target)
      )
        fail(file, line, `浏览器代码不得导入 Host 运行时：${value}`)
    }
    if (
      (base === 'react' || base === 'react-dom') &&
      (file.includes('/src/server/') ||
        file.includes('/src/main/') ||
        ['packages/contracts', 'packages/pi-runtime', 'packages/pi-adapter', 'packages/host'].includes(owner))
    )
      fail(file, line, `服务或基础契约不得导入 React：${value}`)
  }
}
if (failures.length) {
  console.error(`包依赖检查失败（${failures.length} 项）：`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`包依赖检查通过：${files.length} 个文件`)
